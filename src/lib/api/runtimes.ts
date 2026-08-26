/**
 * Which runtime each route handler runs on, declared in one place.
 *
 * ## The short version
 *
 * Next 16 rejects the per-route `export const runtime` segment config outright
 * while `cacheComponents` is enabled, which it is repo-wide (there is no
 * per-route opt-in — see `docs/partial-prerendering.md`). The build fails with
 *
 *   Route segment config "runtime" is not compatible with
 *   `nextConfig.cacheComponents`. Please remove it.
 *
 * for `"edge"` *and* for `"nodejs"`; the check is on the export existing, not
 * on its value. So every route handler here runs on Node, and the spec item
 * this file belongs to cannot be delivered as a segment config. What it can be
 * delivered as is the two things underneath it that actually matter:
 *
 *  1. **A declaration.** Every route says which runtime it runs on and whether
 *     its module graph could move to another one. Written down, in one file,
 *     independently of the code — because an expectation derived from the code
 *     follows the code wherever it drifts, and is not a check.
 *  2. **A gate.** `scripts/assert-api-runtimes.ts` reads the build output after
 *     every CI build and fails if a route is missing, undeclared, built on a
 *     runtime it did not declare, or claims portability while its dependency
 *     trace pulls in Node-only code.
 *
 * The day Cache Components and the edge runtime stop colliding, flipping a
 * route is a one-line change here plus the segment export — and the gate is
 * already in place to prove the flip took effect, which is the part that
 * silently failed to happen for the ISR work (see `scripts/assert-route-shape.ts`).
 *
 * ## Where edge behaviour lives in the meantime
 *
 * `src/proxy.ts`. Next 16's proxy is the supported place for work that has to
 * happen close to the user — the docs point there explicitly for the edge cases
 * `runtime = "edge"` used to serve. `docs/route-handlers.md` covers the
 * tradeoff and what does *not* belong there.
 */

/** The two values Next's segment config accepts, when it accepts it at all. */
export type ApiRuntime = "edge" | "nodejs";

export interface ApiRouteDeclaration {
  /**
   * The route as the build output names it — the app-router path, with dynamic
   * segments in brackets. Not the filesystem path.
   */
  path: string;
  /** The runtime this route is served on today. */
  runtime: ApiRuntime;
  /**
   * Whether the route's module graph is free of Node-only dependencies.
   *
   * This is the property that decides whether a route *could* move to another
   * runtime, and unlike the runtime itself it is not currently forced by the
   * framework — so it is the half of "runtime selection per route" that this
   * repository can actually hold itself to. `assert-api-runtimes.ts` checks it
   * against the build's dependency trace, so a portable route that grows a
   * Prisma import fails CI rather than quietly becoming un-portable.
   */
  portable: boolean;
  /** Why this route is this shape — printed on failure. */
  because: string;
}

export const API_ROUTES: readonly ApiRouteDeclaration[] = [
  {
    path: "/api/health",
    runtime: "nodejs",
    portable: true,
    because:
      "a liveness probe reads nothing; it is the one route that should be servable from anywhere, and is the canary for this file's claims",
  },
  {
    path: "/api/photos",
    runtime: "nodejs",
    portable: true,
    because:
      "the catalogue is an in-repo module, not a table — the route needs no database driver and must not acquire one",
  },
  {
    path: "/api/preview",
    runtime: "nodejs",
    portable: true,
    because:
      "redeems a signed preview token and flips a cookie — the signature is Web Crypto and the cookie is a framework primitive, so nothing here needs a database. It is the route that would most benefit from running at the edge (it sits in front of every CMS preview click), and the portability check is what keeps an import of Prisma 'just to confirm the post exists' from quietly taking that away",
  },
  {
    path: "/api/revalidate",
    runtime: "nodejs",
    portable: true,
    because:
      "verifies an HMAC over the raw request body and drops cache tags — Web Crypto and a framework primitive, with no database read anywhere in it. The portability check is what keeps an existence check on the post ('does this id exist before we revalidate it?') from being added, which would pull Prisma in and make the endpoint's answer depend on replication lag",
  },
  {
    path: "/api/posts",
    runtime: "nodejs",
    portable: false,
    because: "reads the caller's posts through Prisma, which is Node-only",
  },
  {
    path: "/api/posts/paginated",
    runtime: "nodejs",
    portable: false,
    because: "cursor pagination over the same Prisma tables",
  },
  {
    path: "/api/auth/[...nextauth]",
    runtime: "nodejs",
    portable: false,
    because:
      "NextAuth's handler resolves through the Prisma adapter; the edge-safe half of that split is `src/auth.config.ts`, used by the proxy",
  },
];

/**
 * The runtime the current request is actually executing on.
 *
 * `globalThis.EdgeRuntime` is the documented marker — the edge runtime defines
 * it as a string, Node does not define it at all. Read off `globalThis` rather
 * than as a bare identifier so this module needs no ambient declaration and
 * stays a plain module in the test environment.
 *
 * Deliberately *not* derived from `API_ROUTES`: a declaration that reported
 * itself would agree with itself. This reports the runtime that ran the code,
 * which is what makes `/api/health` evidence rather than an echo.
 */
export function detectRuntime(): ApiRuntime {
  const marker = (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime;
  return typeof marker === "string" ? "edge" : "nodejs";
}

/** The declaration for a route, or `undefined` if it is undeclared. */
export function findApiRoute(path: string): ApiRouteDeclaration | undefined {
  return API_ROUTES.find((route) => route.path === path);
}
