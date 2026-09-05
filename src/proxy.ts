/**
 * The first thing every request reaches.
 *
 * Two concerns, in a fixed order: the rate limit, then the session gate. The
 * order is the whole point of doing the limiting here — see
 * `@/lib/rate-limit/enforce` for why "at the edge" is delivered as "before
 * anything else" in Next 16, which has no edge runtime to offer this file.
 */
import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import type { NextAuthRequest } from "next-auth";
import type { NextFetchEvent, NextMiddleware, NextRequest } from "next/server";
import { authConfig } from "@/auth.config";
import {
  applyRateLimitHeaders,
  enforceRateLimit,
  tooManyRequests,
} from "@/lib/rate-limit/enforce";

// Next 16 renamed the `middleware` file convention to `proxy`; keeping the old
// name builds, but emits a deprecation warning, and CI fails on warnings. The
// contract is unchanged — same default-exported handler, same `config.matcher`.
//
// Next 16 statically verifies that this file exports a function. A destructured
// re-export (`export const { auth: proxy } = NextAuth(...)`) is not recognised
// as one, so the handler is bound to a plain const and exported.
const { auth } = NextAuth(authConfig);

/**
 * The session gate, as a callable.
 *
 * `auth` used to be the default export of this file. It is wrapped in a no-op
 * handler now purely so it has the `NextMiddleware` signature and can be called
 * from the composed proxy below; the behaviour is byte-for-byte what
 * `export default auth` did. NextAuth runs `callbacks.authorized` first and, if
 * it returned a `Response` (every redirect in `auth.config.ts`), answers with
 * that and never calls the wrapped handler. Only when it returns `true` does
 * the handler run, and returning `undefined` from it is what NextAuth already
 * substitutes `NextResponse.next()` for.
 */
// The parameters are annotated, and unused, purely to pick the right overload:
// `auth()` accepts a route handler as well as a middleware, the route-handler
// signature is declared first, and a bare `() => undefined` matches it. Naming
// `NextFetchEvent` here is what makes only the middleware overload assignable.
const withSessionGate: NextMiddleware = auth(
  (_request: NextAuthRequest, _event: NextFetchEvent) => undefined,
);

/**
 * NextAuth's own endpoints, which the session gate must not be run on.
 *
 * This exclusion used to live in `config.matcher` below, which meant the whole
 * proxy was skipped for these paths — and `POST /api/auth/callback/credentials`
 * is the password check. It is reachable directly: fetch `/api/auth/csrf` for a
 * token and the cookie that matches it, then post credentials to the callback
 * as often as you like. Every guess went through a full argon2 verification
 * with nothing in front of it, and none of it was counted, because the request
 * never reached this file.
 *
 * So the matcher now covers `/api/auth`, and the exclusion is expressed here
 * instead — where it excludes only the session read, and the rate limit still
 * applies. That is the difference between "do not gate the OAuth callback" (the
 * thing that was wanted) and "do not look at these requests at all" (the thing
 * that was written).
 */
function isAuthEndpoint(pathname: string): boolean {
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

export default async function proxy(
  request: NextRequest,
  event: NextFetchEvent,
): Promise<Response> {
  // One timestamp for the decision, the `Retry-After` and the headers. Reading
  // the clock again further down would produce a slightly later instant and a
  // `Retry-After` a fraction of a second too short.
  const now = Date.now();
  const outcome = await enforceRateLimit(request, { now });

  if (outcome && !outcome.decision.allowed) {
    return tooManyRequests(request, outcome, now);
  }

  const response = isAuthEndpoint(request.nextUrl.pathname)
    ? NextResponse.next()
    : ((await withSessionGate(request, event)) ?? NextResponse.next());

  return applyRateLimitHeaders(response, outcome, now);
}

export const config = {
  // Everything except Next's internals and static assets.
  //
  // `api/auth` is deliberately *not* excluded — see `isAuthEndpoint` above. The
  // session gate still skips those paths; the rate limiter does not.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
