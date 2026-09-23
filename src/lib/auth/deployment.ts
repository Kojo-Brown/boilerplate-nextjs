/**
 * The three settings that decide what a session cookie looks like on the wire,
 * and the one fact all three depend on: whether this deployment's own URL is
 * pinned or inferred from the request.
 *
 * ## The defect this replaces
 *
 * Auth.js decides `trustHost` from `AUTH_URL ?? AUTH_TRUST_HOST ?? VERCEL ??
 * CF_PAGES ?? NODE_ENV !== "production"`. This repository uses the v4 name,
 * `NEXTAUTH_URL` — in `.env.example`, in `src/lib/env.ts`, in the CI workflow
 * and in the Dockerfile — and that name is **not** in the list. So a production
 * build that is not on Vercel or Cloudflare Pages gets `trustHost: false`, and
 * `assertConfig` then refuses every request into `@auth/core` with
 * `UntrustedHost`.
 *
 * That is not a degraded mode. Measured against `pnpm build && pnpm start` on
 * unmodified `main`: `GET /api/auth/csrf` answers **500**, so does
 * `GET /api/auth/session`, and `POST /api/auth/callback/credentials` answers
 * 500 without ever reaching the password check. Nobody can sign in, and nobody
 * who is signed in has a session, because `parseSessionResponse` turns the 500
 * into `null` and every guard fails closed. Every unit test passes, the build
 * exits 0, and all sixteen build gates are green, because none of them start
 * the server and sign in.
 *
 * ## Why `trustHost: true` is the right fix and not a capitulation
 *
 * `trustHost` means "you may work out your own origin from the request". It is
 * dangerous when the answer actually comes from a header, because
 * `x-forwarded-host` is something a client can send: the origin ends up in
 * callback URLs, in redirects and — through `url.protocol` — in whether the
 * cookie is marked `Secure` at all.
 *
 * It is not dangerous when the answer cannot come from a header, and pinning
 * `AUTH_URL` is what makes that so. `createActionURL` prefers the environment
 * URL over `x-forwarded-host`/`x-forwarded-proto` whenever one is set, and
 * `reqWithEnvURL` rewrites the request's origin to it before the proxy's gate
 * runs. So the two are one decision, not two: pin the URL *and* trust the host,
 * or neither.
 *
 * ## Why this module writes to `process.env`
 *
 * Because `createActionURL` reads `process.env.AUTH_URL ?? process.env.
 * NEXTAUTH_URL` directly, not the config object, and there is no configuration
 * field that can reach it. `src/lib/env.ts` gives `NEXTAUTH_URL` a default,
 * which means the value this repository validated and the value Auth.js sees
 * can differ: the schema says `http://localhost:3000`, `process.env` says
 * nothing, and Auth.js quietly goes back to reading headers. Copying the
 * resolved value across is what makes one setting mean one thing. The write is
 * conditional and never overrides an `AUTH_URL` an operator set themselves.
 */
import { env } from "@/lib/env";

/**
 * The origin every absolute URL Auth.js builds is anchored to.
 *
 * Resolved once, at module load, because Auth.js reads `process.env` on every
 * request and a value that could change between them would mean the cookie
 * name (and therefore the JWT's encryption salt) could change between them too.
 */
export const AUTH_ORIGIN: string = resolveAuthOrigin();

/**
 * Whether cookies get the `Secure` attribute and a security prefix.
 *
 * Derived from the pinned origin's scheme rather than from `NODE_ENV`, because
 * the question a browser asks is about the scheme and not about how the bundle
 * was compiled: a production build served over plain HTTP for a local
 * integration run must not mark its cookies `Secure`, or the browser discards
 * every one of them and nothing can sign in.
 *
 * Before this module the same value was computed per request, from
 * `x-forwarded-proto`, on any deployment where the environment URL was unset.
 */
export const USE_SECURE_COOKIES: boolean = AUTH_ORIGIN.startsWith("https:");

/**
 * The session cookie's name, which is also the salt its payload is encrypted
 * under — change it and every outstanding session stops decoding.
 *
 * `__Host-` rather than Auth.js's `__Secure-`. Both require `Secure`; `__Host-`
 * additionally requires `Path=/` and **forbids a `Domain` attribute**, and a
 * browser enforces all three at the moment the cookie is *set*. That last
 * requirement is the one worth having: without it, anything that can write
 * cookies for a sibling name — `staging.example.com`, a subdomain pointed at a
 * third party, an XSS on any host under the registrable domain — can set a
 * `Domain=.example.com` session cookie that the application will read and
 * accept. `__Secure-` does not prevent that; `__Host-` does, because a cookie
 * carrying a `Domain` is rejected before it is ever stored.
 *
 * The cost is stated rather than hidden: a deployment that genuinely needs one
 * session across `app.example.com` and `admin.example.com` cannot use this
 * prefix, because that needs the `Domain` attribute `__Host-` forbids. Such a
 * deployment sets `cookies.sessionToken.name` back to a `__Secure-` name and
 * adds its `domain` — and loses this property knowingly, which is the point of
 * writing it down here.
 */
export const SESSION_COOKIE_NAME: string = USE_SECURE_COOKIES
  ? "__Host-authjs.session-token"
  : "authjs.session-token";

/**
 * Reads the deployment's own URL, and makes Auth.js agree with it.
 *
 * Returns an origin with no trailing slash and no path: `createActionURL`
 * appends `basePath` and the action to whatever it is given, and a URL carrying
 * a path of its own would produce `/app/api/auth/session` on a deployment whose
 * `NEXTAUTH_URL` merely ended in a slash.
 */
function resolveAuthOrigin(): string {
  // `NEXTAUTH_URL` is validated as a URL by the env schema, so this cannot
  // throw for a value that got past it. `AUTH_URL` is Auth.js's own name and is
  // not in the schema, so an operator who set it directly is honoured first and
  // nothing is written back over it.
  const configured = process.env["AUTH_URL"] ?? env.NEXTAUTH_URL;
  const origin = new URL(configured).origin;

  process.env["AUTH_URL"] ??= origin;

  return origin;
}
