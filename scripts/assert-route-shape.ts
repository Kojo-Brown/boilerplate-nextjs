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
import { CATALOGUES } from "../src/i18n/catalogues.js";
import { LOCALES } from "../src/i18n/locales.js";
import { internalPath, splitLocalePath } from "../src/i18n/path.js";

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
 *
 * ## These are public paths; the build output is keyed by segment path
 *
 * `/dashboard` below becomes two expectations, `/en/dashboard` and
 * `/ar/dashboard`, because that is how the prerender manifest keys them now
 * that the tree is under `src/app/[locale]`. `EXPECTED_ROUTES` at the bottom of
 * this block is that cross product.
 *
 * The locale axis is derived from the registry and the per-route expectation is
 * not, and that split is deliberate rather than a weakening of the rule above.
 * What this gate exists to catch is a route whose *shape* changed — a static
 * page that went dynamic, an ISR window that stopped taking effect — and shape
 * is a property of the route, not of the locale it is rendered in. Writing the
 * product out by hand would mean every entry appearing once per locale, so
 * adding a third locale would be fourteen edits, and the one that gets
 * forgotten is a route nobody is checking the shape of in the locale nobody on
 * the team reads. Deriving the axis makes that impossible and leaves the
 * assertion — "this route is a shell containing the navigation" — written down
 * exactly once, independently of the code.
 *
 * `localised: false` is for the documents Next generates outside the segment.
 */
interface BaseRouteExpectation extends RouteExpectation {
  /** `false` for a document that exists once, not once per locale. */
  localised?: false;
  /**
   * Navigation items whose *label in this document's own locale* must appear in
   * the shell, as keys under `nav` in the message catalogues.
   *
   * This is `shellMustContain` for the one kind of needle that is not the same
   * string in every locale, and it had to be separated from it the moment the
   * navigation was wired to the catalogues: `"Dashboard"` is not in the Arabic
   * document, so the six shell expectations failed for `ar` on a shell that was
   * entirely correct.
   *
   * Resolving the needle per locale is sharper than the literal was, not just
   * equivalent. `/ar/dashboard` reported `"Dashboard"` as *present* — the
   * English label is nowhere in that document, but the string is, in the
   * `/dashboard` href next to the Arabic label. A needle that a URL can satisfy
   * is a needle that cannot tell a prerendered navigation from a prerendered
   * link to one.
   */
  shellMustContainNav?: readonly (keyof typeof CATALOGUES.en.nav)[];
}

const BASE_ROUTES: readonly BaseRouteExpectation[] = [
  {
    route: "/",
    kind: "static",
    because: "the landing page reads nothing per-request",
  },
  {
    route: "/_not-found",
    kind: "static",
    // Next generates this one itself, above the `[locale]` segment, so there is
    // exactly one of it and it has no locale. `src/app/[locale]/not-found.tsx`
    // is a different thing — the not-found *boundary* for routes inside the
    // segment — and it is covered by the documents it renders into rather than
    // by a route of its own.
    localised: false,
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
  {
    route: "/photos",
    kind: "static",
    because:
      "the gallery reads an in-repo catalogue; a session read in app/photos/layout.tsx would make it dynamic",
  },
  {
    route: "/photos/[id]",
    kind: "prebuilt",
    // No window: the catalogue is a module, not a database, so there is
    // nothing to revalidate against. `false` here is the correct answer, not a
    // missing one — which is why this expectation omits `revalidateSeconds`
    // rather than asserting a number.
    because:
      "the shareable half of the intercepting-routes pair; a shared link must hit a prebuilt page, not an on-demand render",
  },
  {
    route: "/pricing",
    kind: "static",
    because:
      "the canonical pricing page and the control arm of `pricing-cta`. The proxy varies " +
      "which arm renders, which is the whole reason this page must not vary itself: a " +
      "`headers()` read here to look at the assignment would trade two prerendered " +
      "documents for a server render on every page view",
  },
  {
    route: "/pricing/v/[variant]",
    kind: "prebuilt",
    // No window: the arms come from a module, not a database, so there is
    // nothing to revalidate against — the same reasoning as `/photos/[id]`.
    because:
      "every non-canonical arm must be a prebuilt page. A rewrite that lands on an " +
      "on-demand render puts the cost of the experiment on every visitor in it",
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
      ["/settings/security", "the security settings shell"],
    ] as const
  ).map(([route, what]): BaseRouteExpectation => ({
    route,
    kind: "shell",
    // The sidebar links, which `AppShell` renders without touching the
    // session. If a session read creeps back into `(dashboard)/layout.tsx`
    // these vanish from the shell and this fails. By catalogue key, so each
    // locale's document is checked for its own labels — see
    // `shellMustContainNav`.
    shellMustContainNav: ["dashboard", "posts", "upload"],
    because: `${what} must prerender its navigation; only <UserChip> may stream`,
  })),
];

/**
 * `BASE_ROUTES`, crossed with the locale registry.
 *
 * `internalPath` and not string concatenation: it is the same function the
 * proxy composes a rewrite with, so "the path the gate looks for" and "the path
 * the application sends the request to" cannot disagree. It is also what gets
 * `/` right — the root of a locale is `/en`, not `/en/`.
 */
export const EXPECTED_ROUTES: readonly RouteExpectation[] = BASE_ROUTES.flatMap(
  ({ localised, shellMustContainNav, ...expectation }): RouteExpectation[] => {
    if (localised === false) return [expectation];

    return LOCALES.map((locale) => {
      const navNeedles = (shellMustContainNav ?? []).map(
        (key) => CATALOGUES[locale].nav[key],
      );
      const needles = [...(expectation.shellMustContain ?? []), ...navNeedles];

      return {
        ...expectation,
        route: internalPath(locale, expectation.route),
        ...(needles.length > 0 ? { shellMustContain: needles } : {}),
      };
    });
  },
);

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
    //
    // The segment it points back at carries the literal `[locale]`:
    // `/en/blog/seed-post-cache-life` and `/ar/blog/seed-post-cache-life` both
    // name `/[locale]/blog/[slug]`. So the comparison is against that form, and
    // the locale is applied to the *concrete* side instead — which is what
    // makes this assert per locale rather than once for both. A locale whose
    // `generateStaticParams` returned `[]` while the other's did not would
    // otherwise be invisible here: the segment would still have prebuilt pages,
    // just none of them in that language.
    const { locale, pathname } = splitLocalePath(route);
    const segment = locale === null ? route : internalPathSegment(pathname);
    const prefix = locale === null ? "/" : `/${locale}/`;

    const prebuilt = Object.entries(manifest.routes).filter(
      ([concrete, entry]) =>
        entry.srcRoute === segment && concrete.startsWith(prefix),
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

/**
 * The `srcRoute` form of a public path: `/blog/[slug]` -> `/[locale]/blog/[slug]`.
 *
 * `internalPath` with the segment's own name in place of a locale. Not written
 * as a template literal at the call site so that the one place this repository
 * spells the root segment is `src/app/[locale]`, and a rename is a failing gate
 * rather than a silent mismatch.
 */
function internalPathSegment(pathname: string): string {
  return pathname === "/" ? "/[locale]" : `/[locale]${pathname}`;
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
