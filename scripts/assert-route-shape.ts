/**
 * Asserts that the routes this repository claims are static actually built as
 * static, and that the ISR routes actually carry a revalidation window.
 *
 * This gate exists because the failure it catches is invisible everywhere else.
 * The root layout used to `await auth()`; that reads cookies, a cookie read in
 * a layout is inherited by every route beneath it, and so all 14 routes were
 * server-rendered on demand. `app/blog`'s `export const revalidate = 60` was
 * dead code for as long as that call was there. Nothing failed. No test broke,
 * no warning printed, and the spec listed the ISR work as done. The only
 * evidence was a column missing from the build's route table.
 *
 * So the route table is what we assert. Anyone who adds a `cookies()`,
 * `headers()` or `auth()` call above a static route now fails CI instead of
 * quietly converting the application back to fully dynamic rendering.
 *
 * Usage: tsx scripts/assert-route-shape.ts [path-to-.next]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** The subset of `.next/prerender-manifest.json` this gate reads. */
export interface PrerenderManifest {
  routes: Record<
    string,
    { initialRevalidateSeconds?: number | false; srcRoute?: string | null }
  >;
  dynamicRoutes: Record<string, unknown>;
}

export interface RouteExpectation {
  /** Route path as it appears in the build output. */
  route: string;
  /**
   * `static`   — must be prerendered at build time.
   * `prebuilt` — a dynamic segment whose `generateStaticParams` must yield at
   *              least one concrete prerendered page.
   * `shell`    — Partial Prerendering: a prerendered shell with streamed holes.
   *              Must additionally prove the shell is not empty (see
   *              `shellMustContain`).
   */
  kind: "static" | "prebuilt" | "shell";
  /**
   * Required revalidation window in seconds. `undefined` means "don't care";
   * a number means the built value must match exactly, which is what catches a
   * `revalidate` export that never took effect.
   */
  revalidateSeconds?: number;
  /**
   * Markup that must appear in the prerendered shell for a `shell` route.
   *
   * This is the only honest way to check a shell. Under Cache Components the
   * prerender manifest marks *every* route `PARTIALLY_STATIC` — a fully static
   * page and a shell containing nothing but a `<title>` are indistinguishable
   * in it. So the assertion is made against the HTML the build actually wrote:
   * a shell that no longer contains the navigation is a shell that regressed,
   * whatever the manifest says about it.
   *
   * `/posts` really did prerender 2.6 KB of nothing while the route table
   * happily reported it as partially static.
   */
  shellMustContain?: readonly string[];
  /** Why this route is expected to be this shape — printed on failure. */
  because: string;
}

/**
 * Routes are listed explicitly rather than derived. A derived list would follow
 * the code wherever it drifted to, which is exactly what this gate is here to
 * prevent — the expectation has to be written down independently of the thing
 * it checks, or it is not a check.
 *
 * The API handlers are deliberately absent — they are pure request/response and
 * have no shell to speak of.
 */
export const EXPECTED_ROUTES: readonly RouteExpectation[] = [
  {
    route: "/",
    kind: "static",
    because: "the landing page reads nothing per-request",
  },
  {
    route: "/_not-found",
    kind: "static",
    because: "the 404 page is pure markup",
  },
  {
    route: "/forbidden",
    kind: "static",
    because: "the 403 page is pure markup",
  },
  {
    route: "/login",
    kind: "static",
    because: "the form posts to a Server Action; the shell is static",
  },
  {
    route: "/register",
    kind: "static",
    because: "the form posts to a Server Action; the shell is static",
  },
  {
    route: "/blog",
    kind: "static",
    revalidateSeconds: 60,
    because:
      "the Phase 5 ISR item; a missing window means `revalidate` is dead code again",
  },
  {
    route: "/blog/[slug]",
    kind: "prebuilt",
    revalidateSeconds: 300,
    because: "generateStaticParams must enumerate seeded posts, not return []",
  },

  // The Partial Prerendering routes. Each reads the session — that is the hole
  // — but the dashboard chrome around it must prerender. "Sign out" is
  // deliberately *not* in these lists: it lives in the streamed `<UserChip>`,
  // so requiring it would assert the opposite of what we want.
  ...(
    [
      ["/dashboard", "the dashboard shell"],
      ["/posts", "the posts shell"],
      ["/admin", "the admin shell"],
      ["/images", "the image showcase shell"],
      ["/upload", "the upload shell"],
    ] as const
  ).map(([route, what]): RouteExpectation => ({
    route,
    kind: "shell",
    // The sidebar links, which `AppShell` renders without touching the
    // session. If a session read creeps back into `(dashboard)/layout.tsx`
    // these vanish from the shell and this fails.
    shellMustContain: ["Dashboard", "Posts", "Upload"],
    because: `${what} must prerender its navigation; only <UserChip> may stream`,
  })),
];

export interface Violation {
  route: string;
  problem: string;
  because: string;
}

/**
 * Returns the prerendered HTML for a route, or `null` if the build wrote none.
 * Injected so the tests can describe a regressed shell without running a build.
 */
export type ShellReader = (route: string) => string | null;

/** Reads the shell Next wrote for a route, e.g. `.next/server/app/posts.html`. */
export function createShellReader(nextDir: string): ShellReader {
  return (route) => {
    const relative = route === "/" ? "index" : route.replace(/^\//, "");
    try {
      return readFileSync(
        path.join(nextDir, "server", "app", `${relative}.html`),
        "utf8",
      );
    } catch {
      return null;
    }
  };
}

/**
 * Compares a prerender manifest against the expectations above.
 *
 * Pure and manifest-shaped rather than reading from disk, so the test suite can
 * feed it a regressed manifest without running a build.
 */
export function checkRouteShape(
  manifest: PrerenderManifest,
  expectations: readonly RouteExpectation[] = EXPECTED_ROUTES,
  readShell: ShellReader = () => null,
): Violation[] {
  const violations: Violation[] = [];

  for (const expectation of expectations) {
    const { route, because } = expectation;

    if (expectation.kind === "shell") {
      if (!(route in manifest.routes)) {
        violations.push({
          route,
          problem:
            "expected a partially prerendered (◐) route, but nothing was prerendered for it " +
            "at all — it built as fully dynamic (ƒ). Every dynamic read on this route now " +
            "sits outside a Suspense boundary.",
          because,
        });
        continue;
      }

      const html = readShell(route);
      if (html === null) {
        violations.push({
          route,
          problem:
            "the prerender manifest lists a shell, but no prerendered HTML was written for it.",
          because,
        });
        continue;
      }

      const missing = (expectation.shellMustContain ?? []).filter(
        (needle) => !html.includes(needle),
      );
      if (missing.length > 0) {
        violations.push({
          route,
          problem:
            `the shell prerendered ${html.length} bytes but is missing ${missing.map((m) => JSON.stringify(m)).join(", ")}. ` +
            "The boundary is too high: content that does not depend on the request " +
            "is being streamed instead of prerendered, so the 'static shell' is a near-empty page.",
          because,
        });
      }
      continue;
    }

    if (expectation.kind === "static") {
      const entry = manifest.routes[route];
      if (!entry) {
        violations.push({
          route,
          problem:
            "expected a prerendered (○) route, but it is missing from the prerender manifest — " +
            "it built as server-rendered on demand (ƒ). Something above it reads cookies, " +
            "headers, or the session.",
          because,
        });
        continue;
      }
      pushRevalidateViolation(
        violations,
        expectation,
        entry.initialRevalidateSeconds,
      );
      continue;
    }

    // kind === "prebuilt"
    if (!(route in manifest.dynamicRoutes)) {
      violations.push({
        route,
        problem:
          "expected a dynamic segment with prebuilt pages, but it is not in dynamicRoutes.",
        because,
      });
      continue;
    }

    // `srcRoute` is how a concrete page points back at the segment that
    // produced it, so this counts real prerendered instances rather than
    // trusting that generateStaticParams returned something.
    const prebuilt = Object.entries(manifest.routes).filter(
      ([, entry]) => entry.srcRoute === route,
    );

    if (prebuilt.length === 0) {
      violations.push({
        route,
        problem:
          "expected at least one prebuilt page, but generateStaticParams produced none. " +
          "The build database has no rows to enumerate — run `pnpm db:seed` before building.",
        because,
      });
      continue;
    }

    for (const [concreteRoute, entry] of prebuilt) {
      pushRevalidateViolation(
        violations,
        { ...expectation, route: concreteRoute },
        entry.initialRevalidateSeconds,
      );
    }
  }

  return violations;
}

function pushRevalidateViolation(
  violations: Violation[],
  expectation: RouteExpectation,
  actual: number | false | undefined,
): void {
  const expected = expectation.revalidateSeconds;
  if (expected === undefined) return;

  // `false` is how the manifest spells "prerendered once, never revalidates",
  // which is a different failure from the key being absent — but both mean the
  // revalidation window the source asks for is not in the built output.
  if (actual !== expected) {
    violations.push({
      route: expectation.route,
      problem: `expected a ${expected}s revalidation window, built with ${describeRevalidate(actual)}.`,
      because: expectation.because,
    });
  }
}

function describeRevalidate(value: number | false | undefined): string {
  if (value === undefined) return "no window at all";
  if (value === false) return "revalidation disabled";
  return `${value}s`;
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map(
      (v) =>
        `  ${v.route}\n    ${v.problem}\n    expected because: ${v.because}`,
    )
    .join("\n\n");
}

export function readPrerenderManifest(nextDir: string): PrerenderManifest {
  const manifestPath = path.join(nextDir, "prerender-manifest.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error(
      `Could not read ${manifestPath}. Run \`pnpm build\` before this gate — it reads the build output, not the source.`,
    );
  }
  return JSON.parse(raw) as PrerenderManifest;
}

function main(argv: readonly string[]): number {
  const nextDir = argv[0] ?? ".next";
  const manifest = readPrerenderManifest(nextDir);
  const violations = checkRouteShape(
    manifest,
    EXPECTED_ROUTES,
    createShellReader(nextDir),
  );

  if (violations.length > 0) {
    console.error(
      `Route shape regressed — ${violations.length} route(s) did not build as expected:\n\n${formatViolations(violations)}\n`,
    );
    return 1;
  }

  console.log(`Route shape OK — ${EXPECTED_ROUTES.length} expectations hold.`);
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
