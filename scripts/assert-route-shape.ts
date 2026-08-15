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
   */
  kind: "static" | "prebuilt";
  /**
   * Required revalidation window in seconds. `undefined` means "don't care";
   * a number means the built value must match exactly, which is what catches a
   * `revalidate` export that never took effect.
   */
  revalidateSeconds?: number;
  /** Why this route is expected to be this shape — printed on failure. */
  because: string;
}

/**
 * Routes are listed explicitly rather than derived. A derived list would follow
 * the code wherever it drifted to, which is exactly what this gate is here to
 * prevent — the expectation has to be written down independently of the thing
 * it checks, or it is not a check.
 *
 * Dynamic routes are deliberately absent: `/dashboard`, `/posts`, `/admin`,
 * `/images`, `/upload` and the API handlers read the session and are supposed
 * to be `ƒ`. Asserting they stay dynamic would fail the day someone correctly
 * makes one of them a static shell with a streamed hole.
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
];

export interface Violation {
  route: string;
  problem: string;
  because: string;
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
): Violation[] {
  const violations: Violation[] = [];

  for (const expectation of expectations) {
    const { route, because } = expectation;

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
  const violations = checkRouteShape(manifest);

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
