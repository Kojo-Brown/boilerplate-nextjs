/**
 * The first thing every request reaches.
 *
 * Six concerns, in a fixed order: the rate limit, locale negotiation, the
 * session gate, experiment routing, the Content Security Policy, then the fixed
 * hardening headers. The first is the whole point of doing the limiting here —
 * see `@/lib/rate-limit/enforce` for why "at the edge" is delivered as "before
 * anything else" in Next 16, which has no edge runtime to offer this file.
 *
 * The second is second because every concern after it needs to know which
 * locale this request is for, and because the answer is sometimes "none of
 * them, send a redirect" — a request that is about to be bounced to `/ar` has
 * no session to gate, no arm to bucket and no document whose digests a policy
 * could carry. `next-intl`'s middleware is used for its *redirects* only, and
 * the rewrite it would have produced is rebuilt below; see
 * `negotiateLocale`.
 *
 * The third is third for a reason of its own. Bucketing decides which *variant*
 * of a page to render, which is only a question worth answering for a request
 * that is going to be served at all: a refused request gets its cookies (so the
 * visitor survives a login) and no rewrite. See `@/lib/experiments/edge`.
 *
 * The fourth needs the third's answer: the policy carries the
 * hashes of the document that will actually be rendered, and for a rewritten
 * request that is the variant's path rather than the one in the address bar. It
 * is also the only one of the five that has to reach the *render* — Next takes
 * the nonce from the request's policy header — so it is applied to the request
 * headers the rewrite carries, not only to the response. See
 * `@/lib/security/apply`.
 *
 * The fifth is last because it depends on nothing and must not be depended on:
 * `@/lib/security/headers` is five single-valued headers with fixed answers, and
 * running it after everything else is what makes "this value is the one that
 * ships" true without a reader having to check whether an earlier step set the
 * same name. Every return path goes through it, refusals included — a 429 that
 * is missing `nosniff` is still a response a browser will sniff.
 */
import createIntlMiddleware from "next-intl/middleware";
import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import type { NextAuthRequest } from "next-auth";
import type { NextFetchEvent, NextMiddleware, NextRequest } from "next/server";
import { authConfig } from "@/auth.config";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/locales";
import { internalPath, splitLocalePath } from "@/i18n/path";
import { routing } from "@/i18n/routing";
import { USE_SECURE_COOKIES } from "@/lib/auth/deployment";
import { hardenSessionToken, reportSessionEvent } from "@/lib/auth/harden";
import { sessionRegistry } from "@/lib/auth/registry";
import {
  applyExperiments,
  carryOverHeaders,
  resolveExperimentContext,
  sanitisedRequestHeaders,
} from "@/lib/experiments/edge";
import { participates } from "@/lib/experiments/routing";
import {
  applyRateLimitHeaders,
  enforceRateLimit,
  tooManyRequests,
} from "@/lib/rate-limit/enforce";
import {
  applyCspHeaders,
  applyCspRequestHeaders,
  decideCsp,
} from "@/lib/security/apply";
import { applyHardeningHeaders } from "@/lib/security/headers";

// Next 16 renamed the `middleware` file convention to `proxy`; keeping the old
// name builds, but emits a deprecation warning, and CI fails on warnings. The
// contract is unchanged — same default-exported handler, same `config.matcher`.
//
// Next 16 statically verifies that this file exports a function. A destructured
// re-export (`export const { auth: proxy } = NextAuth(...)`) is not recognised
// as one, so the handler is bound to a plain const and exported.
/**
 * The proxy's own NextAuth instance, and the only one allowed to rotate.
 *
 * `authConfig` deliberately carries no `jwt` callback: it is the import-light
 * half of the split, and the registry it would need reaches Prisma. The
 * callback is composed here instead, which puts the database dependency in the
 * file whose job is to touch every request, where a reader will see it.
 *
 * `mayRotate: true` is true here and nowhere else because this is the one place
 * the token returned from the callback actually reaches the browser. Auth.js
 * re-encrypts it and pushes a `Set-Cookie` onto the session response, and
 * `handleAuth` copies those headers onto the response this function returns —
 * which `applyExperiments`, `applyRateLimitHeaders` and `applyCspHeaders` all
 * preserve. Verified against a running production build rather than read off
 * the source: every proxied response carries a fresh `authjs.session-token`.
 */
const { auth } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    jwt: ({ token, user }) =>
      hardenSessionToken(
        { token, user, mayRotate: true },
        {
          registry: sessionRegistry,
          now: () => new Date(),
          newId: () => crypto.randomUUID(),
          report: reportSessionEvent,
        },
      ),
  },
});

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

/**
 * `next-intl`'s middleware, and the one thing this file takes from it.
 *
 * It does three jobs: it redirects when the URL is not the canonical one for
 * the locale it resolved (`/en/blog` -> `/blog`, and `/` -> `/ar` for a visitor
 * whose cookie or `Accept-Language` says so), it writes the `NEXT_LOCALE`
 * cookie, and it rewrites the request onto the `[locale]` segment.
 *
 * Only the first two are used here. The rewrite is rebuilt by `proxy` below,
 * and has to be, because this file already owns a rewrite — `/pricing` becomes
 * `/pricing/v/<variant>` for a bucketed visitor — and two middlewares cannot
 * each return the response. Letting `next-intl` return its own would mean
 * either losing the experiment arm or losing the Content Security Policy's
 * request header, which is what carries the nonce into the render.
 *
 * So the composition is: honour the redirect if there is one, keep the cookie
 * either way, and otherwise compute the segment path here with `internalPath`.
 */
const intlMiddleware = createIntlMiddleware({
  ...routing,
  /**
   * `Secure` on a deployment whose own URL is `https:`, which `next-intl` does
   * not do by default — its default is `{name: "NEXT_LOCALE", sameSite: "lax"}`
   * and nothing else, so the cookie would be sent over plaintext by a browser
   * that had ever been talked into one.
   *
   * It is configured here rather than in `@/i18n/routing` because that module
   * is imported by `@/i18n/navigation`, which reaches client bundles, and
   * `USE_SECURE_COOKIES` comes from `@/lib/auth/deployment` — which reads
   * `NEXTAUTH_URL`. The cookie is only ever written by this middleware, so this
   * is the only place that needs to know.
   *
   * There is no `httpOnly` to set: `next-intl` does not accept one, and this is
   * a display preference rather than a credential. Everything that decides
   * anything from it re-derives the locale from the path.
   */
  localeCookie: { secure: USE_SECURE_COOKIES },
});

interface Negotiated {
  /** `next-intl`'s own response, kept for the headers it set. */
  readonly response: NextResponse;
  /** Set when `next-intl` wants the browser somewhere else. */
  readonly redirect: NextResponse | undefined;
  /** The locale every later step works in. */
  readonly locale: Locale;
  /** The request path with the locale prefix removed. */
  readonly pathname: string;
}

/**
 * Which locale this request is for, and whether it should be here at all.
 *
 * The locale is read back off the path rather than out of `next-intl`'s
 * response, and that is sound rather than a shortcut: under
 * `localePrefix: "as-needed"` a request whose locale differs from the one the
 * path implies is *redirected*, never passed through. So a pass-through at a
 * prefixed path is that prefix's locale, and a pass-through at an unprefixed
 * path is the default — there is no third case, and reading
 * `x-middleware-rewrite` back out of the response to find out would be
 * depending on an internal header to learn something the path already says.
 *
 * `DEFAULT_LOCALE` is the fallback for a path with no prefix. An unknown first
 * segment (`/favicon.png`) is not a locale and not a redirect either; it
 * resolves to the default here and is answered by the `notFound()` in
 * `src/app/[locale]/layout.tsx`.
 */
function negotiateLocale(request: NextRequest): Negotiated {
  const { locale, pathname } = splitLocalePath(request.nextUrl.pathname);

  // `/api/*` is not under `src/app/[locale]`, so it has no locale to negotiate
  // and must not be redirected into one. `next-intl`'s middleware does not know
  // that: the first segment of `/api/health` is not a locale, so it reads the
  // path as unprefixed and answers with a rewrite to `/en/api/health` — or, for
  // a visitor whose cookie says `ar`, a *redirect* to `/ar/api/health`. Either
  // one is a route handler that does not exist, and the second would have
  // turned every `fetch` from an Arabic page into a 404, `/api/auth/callback`
  // included. `participates` is the existing answer to "is this a page", and
  // the same list is the right one here.
  if (!participates(pathname)) {
    return {
      response: NextResponse.next(),
      redirect: undefined,
      locale: locale ?? DEFAULT_LOCALE,
      pathname,
    };
  }

  const response = intlMiddleware(request);
  const redirect = response.headers.has("location") ? response : undefined;

  return { response, redirect, locale: locale ?? DEFAULT_LOCALE, pathname };
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
    // A refusal renders no document, so there is nothing here for a nonce to
    // stamp — but the policy still goes on the response. One policy on every
    // response is a property a reader can check; "on the responses that happen
    // to carry markup" is a rule someone has to re-derive at each caller.
    return applyHardeningHeaders(
      applyCspHeaders(
        tooManyRequests(request, outcome, now),
        decideCsp(request),
      ),
      request,
    );
  }

  // Before the session gate, because a request that is about to be redirected
  // to another locale has no session worth reading — and before the experiment
  // context, which needs the locale-stripped path to match the registry at all.
  const negotiated = negotiateLocale(request);

  if (negotiated.redirect) {
    // Hardened and given a policy like every other return path. A redirect
    // renders no document, so there is nothing for a nonce to stamp; the
    // argument is the one the 429 above makes — one policy on every response is
    // a property a reader can check.
    return applyHardeningHeaders(
      applyCspHeaders(negotiated.redirect, decideCsp(request)),
      request,
    );
  }

  const gated = isAuthEndpoint(request.nextUrl.pathname)
    ? NextResponse.next()
    : ((await withSessionGate(request, event)) ?? NextResponse.next());

  // Resolved before the response is composed and after the gate has run: the
  // context is pure and cheap, and `applyExperiments` needs to know what the
  // gate decided in order to leave a refusal alone. It also strips the
  // client-supplied copies of the proxy's own headers on *every* path,
  // including the ones that take no part in bucketing — which is why this is
  // not inside a branch.
  const experiments = resolveExperimentContext(request);

  // The segment path that will actually render, which is what both the rewrite
  // and the policy need.
  //
  // Two substitutions, in this order: the arm replaces the canonical path
  // (`/pricing` -> `/pricing/v/annual-first`), and then the locale is put on
  // the front (`-> /ar/pricing/v/annual-first`). Composed the other way round
  // the arm would be appended to a path that already carries a locale, which is
  // the same string here but stops being one the moment an experiment's
  // `rewritePrefix` is not a suffix of its canonical path.
  //
  // `undefined` for the paths outside the `[locale]` segment. `participates`
  // is the existing answer to "is this a page or an API route", and it is the
  // right one for this question too — `/api/health` has no locale, no shell and
  // nothing to rewrite.
  const served = participates(negotiated.pathname)
    ? internalPath(
        negotiated.locale,
        experiments.rewrite?.to ?? negotiated.pathname,
      )
    : undefined;

  // The policy needs the rendered document, not the one in the address bar:
  // `/pricing` renders `/en/pricing/v/control`, and it is the *rendered*
  // document whose inline scripts have to be authorised. Before the `[locale]`
  // segment this was `experiments.rewrite?.to` and `undefined` for every
  // unbucketed request, because the two paths were the same string; they are
  // not any more, so every page request has to say which document it serves or
  // the manifest lookup misses and the shell's scripts go unauthorised.
  const csp = decideCsp(request, served === undefined ? {} : { served });

  // The request headers the rewrite (or the pass-through) carries. Built here so
  // the policy can be added to them before the render reads it; `applyExperiments`
  // would otherwise build its own copy and the nonce would never reach Next.
  const requestHeaders = applyCspRequestHeaders(
    sanitisedRequestHeaders(request, experiments),
    csp,
  );

  const response = applyExperiments(request, experiments, gated, {
    requestHeaders,
    rewriteTo: served,
  });

  // `next-intl`'s `NEXT_LOCALE` cookie and its `Link` alternate-links header.
  // The response was rebuilt above, so they do not survive on their own — and
  // without the cookie a visitor who was redirected to `/ar` once is
  // renegotiated from `Accept-Language` on every later request.
  carryOverHeaders(negotiated.response, response);

  return applyHardeningHeaders(
    applyCspHeaders(applyRateLimitHeaders(response, outcome, now), csp),
    request,
  );
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
