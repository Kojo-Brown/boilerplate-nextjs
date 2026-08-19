/**
 * Asserts that the route handlers this repository declares in
 * `src/lib/api/runtimes.ts` are the ones it actually built, on the runtimes it
 * says they run on, with the dependency graphs it claims for them.
 *
 * This is the same argument as `scripts/assert-route-shape.ts`, applied to the
 * API surface. That gate exists because a cookie read in a layout silently
 * converted fourteen static routes to on-demand rendering and nothing failed.
 * The equivalent here is quieter still: a route's runtime and its portability
 * are properties of its *module graph*, so a single added import changes both,
 * changes neither's source line, and produces a green build. `/api/photos`
 * reads an in-repo module today; the day someone gives it a Prisma query for
 * convenience it stops being movable, and without this nothing says so.
 *
 * Four things are checked, from the build output rather than from the source:
 *
 *  1. Every declared route was built.
 *  2. Every built route handler is declared — drift in the other direction, so
 *     a new endpoint cannot appear without a runtime decision being recorded.
 *  3. Each route's built runtime matches its declaration.
 *  4. Each route declared `portable` traces no dependency outside the framework
 *     itself, which is the property that decides whether it *could* move.
 *
 * Check 3 is currently a one-sided assertion — Next 16 rejects the per-route
 * `runtime` segment config outright while `cacheComponents` is on, so `nodejs`
 * is the only answer available and this gate's job is to notice if that ever
 * changes underneath us. `src/lib/api/runtimes.ts` has the citation. Checks 1,
 * 2 and 4 are live today.
 *
 * Usage: tsx scripts/assert-api-runtimes.ts [path-to-.next]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { API_ROUTES } from "../src/lib/api/runtimes";
import type { ApiRouteDeclaration, ApiRuntime } from "../src/lib/api/runtimes";

/** `{ "/api/posts/route": "/api/posts" }` — build path to route path. */
export type AppPathRoutesManifest = Record<string, string>;

/**
 * `functions` holds the routes compiled into the edge bundle. A Node route is
 * absent from it entirely, which is what makes presence here the honest test
 * for "built as edge" rather than anything the source claimed.
 */
export interface MiddlewareManifest {
  functions?: Record<string, unknown>;
}

/** `.next/server/app/**\/route.js.nft.json` — the traced dependency file list. */
export interface NftTrace {
  files: string[];
}

/**
 * Packages a portable route may trace.
 *
 * An allowlist, not a list of banned packages. A blacklist of `@prisma`, `pg`
 * and friends would pass the first time someone reached for a different
 * Node-only library, and would need editing on every dependency change; this
 * needs editing only when the framework's own runtime footprint changes, and
 * fails closed in the meantime.
 *
 * These three are what a route tracing nothing but `defineRoute` and an in-repo
 * module pulls in: Next itself, React, and SWC's emitted helpers.
 */
export const FRAMEWORK_PACKAGES: readonly string[] = [
  "next",
  "react",
  "@swc/helpers",
];

export interface Violation {
  route: string;
  problem: string;
  because: string;
}

/** Reads a route's traced dependency list, or `null` if the build wrote none. */
export type TraceReader = (routePath: string) => NftTrace | null;

export function createTraceReader(nextDir: string): TraceReader {
  return (routePath) => {
    // "/api/posts" -> ".next/server/app/api/posts/route.js.nft.json". Dynamic
    // segments keep their brackets on disk, so no escaping is needed.
    const file = path.join(
      nextDir,
      "server",
      "app",
      routePath,
      "route.js.nft.json",
    );
    try {
      return JSON.parse(readFileSync(file, "utf8")) as NftTrace;
    } catch {
      return null;
    }
  };
}

/**
 * The npm package a traced path belongs to, or `null` for a first-party file.
 *
 * pnpm's layout puts the real package two levels in
 * (`node_modules/.pnpm/<id>/node_modules/<pkg>`), so the optional `.pnpm`
 * segment has to be consumed before the name is read — otherwise every
 * dependency in this repository reports as the package `.pnpm`.
 */
export function packageOf(file: string): string | null {
  const match =
    /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(
      file,
    );
  return match?.[1] ?? null;
}

/** Distinct non-framework packages a route traces. Empty means portable. */
export function foreignPackages(
  trace: NftTrace,
  framework: readonly string[] = FRAMEWORK_PACKAGES,
): string[] {
  const found = new Set<string>();
  for (const file of trace.files) {
    const pkg = packageOf(file);
    // `.pnpm` itself appears for store-level files that belong to no package
    // (the virtual store's own bookkeeping); it is not a dependency.
    if (pkg && pkg !== ".pnpm" && !framework.includes(pkg)) found.add(pkg);
  }
  return [...found].sort();
}

/** The runtime a route was actually built on. */
export function builtRuntime(
  manifest: MiddlewareManifest,
  routePath: string,
): ApiRuntime {
  return `${routePath}/route` in (manifest.functions ?? {}) ? "edge" : "nodejs";
}

/** Every route handler in the build, as route paths. */
export function builtRouteHandlers(manifest: AppPathRoutesManifest): string[] {
  return Object.entries(manifest)
    .filter(([buildPath]) => buildPath.endsWith("/route"))
    .map(([, routePath]) => routePath)
    .sort();
}

export function checkApiRuntimes(
  appPaths: AppPathRoutesManifest,
  middleware: MiddlewareManifest,
  readTrace: TraceReader,
  declarations: readonly ApiRouteDeclaration[] = API_ROUTES,
): Violation[] {
  const violations: Violation[] = [];
  const built = builtRouteHandlers(appPaths);
  const declaredPaths = new Set(declarations.map((d) => d.path));

  for (const routePath of built) {
    if (!declaredPaths.has(routePath)) {
      violations.push({
        route: routePath,
        problem:
          "built as a route handler but is not declared in `API_ROUTES`. Every endpoint " +
          "records the runtime it runs on and whether its dependencies allow it to move; " +
          "an undeclared one has had neither decision made.",
        because:
          "src/lib/api/runtimes.ts is the API surface, not a subset of it",
      });
    }
  }

  for (const declaration of declarations) {
    const { path: routePath, runtime, portable, because } = declaration;

    if (!built.includes(routePath)) {
      violations.push({
        route: routePath,
        problem:
          "is declared in `API_ROUTES` but no route handler was built for it — it was " +
          "deleted, renamed, or moved under a `_private` folder that opts out of routing.",
        because,
      });
      continue;
    }

    const actualRuntime = builtRuntime(middleware, routePath);
    if (actualRuntime !== runtime) {
      violations.push({
        route: routePath,
        problem: `declares the ${runtime} runtime but built on ${actualRuntime}.`,
        because,
      });
    }

    if (!portable) continue;

    const trace = readTrace(routePath);
    if (trace === null) {
      violations.push({
        route: routePath,
        problem:
          "declares itself portable, but the build wrote no dependency trace for it, so " +
          "the claim cannot be checked. A claim that cannot fail is not a check.",
        because,
      });
      continue;
    }

    const foreign = foreignPackages(trace);
    if (foreign.length > 0) {
      violations.push({
        route: routePath,
        problem:
          `declares itself portable but traces ${foreign.length} package(s) outside the ` +
          `framework: ${foreign.join(", ")}. Either the import that pulled them in does not ` +
          "belong on this route, or the route is no longer portable and `API_ROUTES` should say so.",
        because,
      });
    }
  }

  return violations;
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map(
      (v) =>
        `  ${v.route}\n    ${v.problem}\n    declared because: ${v.because}`,
    )
    .join("\n\n");
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
  const middleware = readJson<MiddlewareManifest>(
    path.join(nextDir, "server", "middleware-manifest.json"),
    hint,
  );

  const violations = checkApiRuntimes(
    appPaths,
    middleware,
    createTraceReader(nextDir),
    API_ROUTES,
  );

  if (violations.length > 0) {
    console.error(
      `API runtime declarations regressed — ${violations.length} route(s) did not build as declared:\n\n${formatViolations(violations)}\n`,
    );
    return 1;
  }

  const portable = API_ROUTES.filter((route) => route.portable).length;
  console.log(
    `API runtimes OK — ${API_ROUTES.length} route(s) built as declared, ${portable} of them with a framework-only dependency trace.`,
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
