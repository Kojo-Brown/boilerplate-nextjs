/**
 * Asserts that every endpoint this application built is actually reachable by
 * the rate limiter, and that every one of them has a budget or a written reason
 * not to.
 *
 * The same argument as the gates beside it, applied to a defence whose failure
 * mode is invisible by construction. A rate limit that is not applied looks
 * exactly like one that is: the endpoint answers, the tests pass, the build is
 * green, and the only evidence is traffic nobody is counting. There are two
 * ways for that to happen here and this gate closes both.
 *
 *  1. **The endpoint is outside the proxy's matcher.** The limiter runs in
 *     `src/proxy.ts`, and a path the matcher excludes never reaches it. That is
 *     not hypothetical: `api/auth` was excluded — for a good reason, so the
 *     OAuth callback would not be gated by the session check — and the effect
 *     was that `POST /api/auth/callback/credentials`, one argon2 verification
 *     per request, was unreachable by anything. The exclusion is now expressed
 *     in code that skips only the session read, and this check is what stops it
 *     migrating back into the matcher.
 *
 *     The matcher is read from `.next/server/functions-config-manifest.json`,
 *     which is the *compiled* regex Next will actually apply, not the source
 *     string. A gate that re-implemented the matcher syntax would be asserting
 *     against its own reading of it.
 *
 *  2. **The endpoint matches no rule.** `selectPolicy` returning `undefined` is
 *     a legitimate answer for a page navigation and a bug for a route handler.
 *     Every route handler in the build must either select a policy or appear in
 *     `RATE_LIMIT_EXEMPT` with a reason.
 *
 * The proxy's runtime is reported rather than asserted. Next 16 always runs the
 * proxy on Node — `get-page-static-info.js` rejects a runtime segment config in
 * that file outright — so there is nothing to fail on today, and printing it is
 * what will make a future change visible in the build log instead of silently
 * altering where this code executes.
 *
 * Usage: tsx scripts/assert-rate-limit-coverage.ts [path-to-.next]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  RATE_LIMIT_EXEMPT,
  isApiPath,
  selectPolicy,
} from "../src/lib/rate-limit/policy";

/** `{ "/api/posts/route": "/api/posts" }` — build path to route path. */
export type AppPathRoutesManifest = Record<string, string>;

export interface FunctionsConfigManifest {
  functions?: Record<
    string,
    { runtime?: string; matchers?: { regexp?: string }[] }
  >;
}

export interface Violation {
  route: string;
  problem: string;
}

/** The key Next writes the proxy's compiled configuration under. */
export const PROXY_FUNCTION_KEY = "/_middleware";

export interface ProxyConfig {
  runtime: string;
  matchers: RegExp[];
}

/**
 * The proxy's compiled matchers.
 *
 * Throws rather than returning an empty list when the entry is missing. "No
 * matchers" and "matches everything" are indistinguishable to a check that
 * treats absence as a value, and the direction that fails is the one that
 * silently passes.
 */
export function readProxyConfig(
  manifest: FunctionsConfigManifest,
): ProxyConfig {
  const entry = manifest.functions?.[PROXY_FUNCTION_KEY];
  if (!entry) {
    throw new Error(
      `${PROXY_FUNCTION_KEY} is absent from the functions config manifest. ` +
        "Either src/proxy.ts was deleted, or it no longer exports a handler Next recognises — " +
        "in which case nothing in this repository is rate limited.",
    );
  }

  const matchers = (entry.matchers ?? [])
    .map((matcher) => matcher.regexp)
    .filter((regexp): regexp is string => typeof regexp === "string")
    .map((regexp) => new RegExp(regexp, "u"));

  if (matchers.length === 0) {
    throw new Error(
      `${PROXY_FUNCTION_KEY} declares no matchers, so this gate cannot tell which requests reach the proxy.`,
    );
  }

  return { runtime: entry.runtime ?? "unknown", matchers };
}

/**
 * A concrete path a request could actually arrive at.
 *
 * The manifest names dynamic segments as they appear on disk (`/posts/[id]`,
 * `/blog/[...slug]`), and the matcher is a regex over real URLs. Substituting a
 * plain segment is what makes the two comparable; the value does not matter as
 * long as it contains no slash for a single segment.
 */
export function sampleUrl(routePath: string): string {
  return routePath
    .replace(/\[\[?\.\.\.[^\]]+\]\]?/gu, "sample/segments")
    .replace(/\[[^\]]+\]/gu, "sample");
}

export function isMatched(url: string, matchers: readonly RegExp[]): boolean {
  return matchers.some((matcher) => matcher.test(url));
}

/** Every page and route handler in the build, as route paths. */
export function builtRoutes(manifest: AppPathRoutesManifest): {
  routeHandlers: string[];
  pages: string[];
} {
  const routeHandlers: string[] = [];
  const pages: string[] = [];

  for (const [buildPath, routePath] of Object.entries(manifest)) {
    if (buildPath.endsWith("/route")) routeHandlers.push(routePath);
    else if (buildPath.endsWith("/page")) pages.push(routePath);
  }

  return { routeHandlers: routeHandlers.sort(), pages: pages.sort() };
}

const exemptPaths = new Set(RATE_LIMIT_EXEMPT.map((entry) => entry.path));

export function checkRateLimitCoverage(
  appPaths: AppPathRoutesManifest,
  proxy: ProxyConfig,
): Violation[] {
  const violations: Violation[] = [];
  const { routeHandlers, pages } = builtRoutes(appPaths);

  for (const routePath of routeHandlers) {
    const url = sampleUrl(routePath);

    if (!isMatched(url, proxy.matchers)) {
      violations.push({
        route: routePath,
        problem:
          "is not matched by the proxy, so no request to it is ever counted. If it has to be " +
          "excluded from the session gate, exclude it there — `isAuthEndpoint` in src/proxy.ts " +
          "is the shape for that — rather than from the matcher, which excludes it from " +
          "everything.",
      });
      continue;
    }

    if (exemptPaths.has(routePath)) continue;

    // A route handler is reached by whichever method it exports; the write
    // methods are the ones a missing budget actually costs, so the check is
    // made on a POST.
    const selected = selectPolicy({
      method: "POST",
      pathname: url,
      isServerAction: false,
    });

    if (!selected) {
      violations.push({
        route: routePath,
        problem:
          "matches no rule in `RATE_LIMIT_RULES` and is not listed in `RATE_LIMIT_EXEMPT`, so it " +
          "has no budget. Add a rule, or add it to the exempt list with the reason it needs none.",
      });
    }
  }

  // A page is a Server Action endpoint whether or not it hosts one today: every
  // export of a `"use server"` module is a POST target, and which page a form
  // posts to is a rendering detail. So the matcher has to cover the pages too.
  for (const routePath of pages) {
    const url = sampleUrl(routePath);
    if (isApiPath(url) || isMatched(url, proxy.matchers)) continue;

    violations.push({
      route: routePath,
      problem:
        "is not matched by the proxy. Any page can host a Server Action, and a Server Action " +
        "posted to an unmatched path is an unlimited mutation endpoint.",
    });
  }

  return violations;
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations.map((v) => `  ${v.route}\n    ${v.problem}`).join("\n\n");
}

function readJson<T>(file: string, hint: string): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    throw new Error(`Could not read ${file}. ${hint}`);
  }
}

function main(argv: readonly string[]): number {
  const nextDir = argv[0] ?? ".next";
  const hint =
    "Run `pnpm build` before this gate — it reads the build output, not the source.";

  const appPaths = readJson<AppPathRoutesManifest>(
    path.join(nextDir, "app-path-routes-manifest.json"),
    hint,
  );
  const manifest = readJson<FunctionsConfigManifest>(
    path.join(nextDir, "server", "functions-config-manifest.json"),
    hint,
  );

  const proxy = readProxyConfig(manifest);
  const violations = checkRateLimitCoverage(appPaths, proxy);

  if (violations.length > 0) {
    console.error(
      `Rate limit coverage regressed — ${violations.length} route(s) are not counted:\n\n${formatViolations(violations)}\n`,
    );
    return 1;
  }

  const { routeHandlers, pages } = builtRoutes(appPaths);
  console.log(
    `Rate limit coverage OK — ${routeHandlers.length} route handler(s) and ${pages.length} page(s) ` +
      `reach the proxy, ${RATE_LIMIT_EXEMPT.length} endpoint(s) exempt by declaration. ` +
      `Next built the proxy on the ${proxy.runtime} runtime.`,
  );
  return 0;
}

/* c8 ignore start -- CLI entry; the logic above is what the tests exercise. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
/* c8 ignore stop */
