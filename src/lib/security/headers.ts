/**
 * The response headers that are the same on every response, and why each one is
 * here rather than left to the Content Security Policy.
 *
 * `@/lib/security/csp` is the interesting half of the policy — per-request,
 * per-document, and the thing `scripts/assert-csp.ts` spends 964 lines on. This
 * file is the boring half: five headers with no inputs. They are worth a module
 * of their own precisely because they had *no* module, and a header that nobody
 * owns is a header nobody notices the absence of. Before this, a response from
 * this application carried a CSP and nothing else.
 *
 * ## The five
 *
 *   `X-Content-Type-Options: nosniff`
 *       Stops a browser second-guessing a `Content-Type`. The reason this
 *       matters here is `/api`: every route handler answers `application/json`,
 *       and a JSON body is attacker-influenced content by definition — a
 *       response whose type is ignored and whose body is sniffed as HTML is a
 *       stored XSS on this origin, with the CSP as the only thing left standing.
 *       Also stops a stylesheet being loaded from something that is not CSS.
 *
 *   `X-Frame-Options: DENY`
 *       Redundant with `frame-ancestors 'none'` in every browser that enforces
 *       CSP — and *not* redundant in the two states this application can be
 *       deployed in where the CSP is not enforced at all: `CSP_REPORT_ONLY=1`,
 *       which is the documented rollout mode, and a production server with no
 *       hash manifest, which `@/lib/security/apply` degrades to report-only on
 *       purpose rather than serve an outage. In both, `frame-ancestors` is a
 *       line a browser reports and does not act on, so clickjacking protection
 *       would silently be gone. This header is enforced in both. That is the
 *       whole argument for it; without report-only mode it would be dead weight.
 *
 *   `Referrer-Policy: strict-origin-when-cross-origin`
 *       Already the default in current Chrome and Firefox, which is the honest
 *       thing to say about it: on a modern browser this header changes nothing.
 *       It is one line, it pins the behaviour against a browser that defaults to
 *       something looser, and it means the value is stated somewhere a reader can
 *       find it. It is deliberately not `no-referrer`: this application's own
 *       `/api/vitals` and the analytics script in `@/lib/third-party/catalogue`
 *       both read the origin, and `no-referrer` would also break an inbound
 *       referrer a consumer may well want.
 *
 *   `Permissions-Policy`
 *       Denies the powerful features nothing here uses. The value of this is not
 *       against this application's own code — it is that an injected script, or
 *       an iframe a consumer later embeds, cannot prompt for a camera or a
 *       payment handler on this origin's behalf. `()` is the empty allowlist:
 *       no origin, not even this one.
 *
 *   `Strict-Transport-Security`
 *       Only on a request that arrived over TLS. A browser ignores this header
 *       on a plain-HTTP response, so sending it there would be a line that reads
 *       like a protection and does nothing — and on `http://localhost:3000` it
 *       would be a line whose effect a developer has to go into browser settings
 *       to undo, on a hostname shared with every other project on the machine.
 *       `isSecureRequest` is the same predicate that decides the session cookie's
 *       `Secure` attribute, so the two cannot disagree.
 *
 * ## Why `preload` is absent
 *
 * `preload` asks for the domain to be baked into browsers' shipped HSTS list,
 * which takes months to reverse and applies to every subdomain. That is a
 * decision about somebody's DNS, not about a boilerplate, and the one thing a
 * default must not do is make it for them. `includeSubDomains` is here because
 * the failure it prevents — a sibling subdomain served over plain HTTP setting a
 * cookie this origin's browser will send — is the same failure the `__Host-`
 * cookie prefix in `@/lib/auth/deployment` is defending against, and defending
 * it in one layer only is how that kind of thing gets lost.
 *
 * ## Where this does *not* reach
 *
 * The proxy's `config.matcher` excludes `_next/static`, `_next/image` and image
 * extensions, so none of these headers is on those responses. That is accepted
 * rather than overlooked: those bodies are build output with types Next sets
 * itself, they are not documents, and the alternative — a second copy in
 * `next.config.ts`'s `headers()`, which does cover them — would mean two sources
 * of truth and two values of every header on the paths that match both. A
 * deployment that wants them on static assets should set them at its CDN, which
 * is where those responses are served from anyway.
 */
import { isSecureRequest } from "@/lib/experiments/cookies";
import type { NextRequest } from "next/server";

/** Two years, the value the HSTS preload list requires as a minimum. */
export const HSTS_MAX_AGE_S = 63072000;

export const HSTS_HEADER = "strict-transport-security";

/**
 * The headers that do not depend on the request.
 *
 * A frozen record rather than a function, so a test can enumerate it and so
 * `scripts/assert-owasp-coverage.ts` can read the set without executing a
 * request. Lowercase keys because `Headers` is case-insensitive and one casing
 * makes the assertions below comparable.
 */
export const STATIC_HARDENING_HEADERS: Readonly<Record<string, string>> =
  Object.freeze({
    "x-content-type-options": "nosniff",
    // See the module header: this is the backstop for the two deployments where
    // `frame-ancestors` is sent report-only.
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": [
      "accelerometer=()",
      "camera=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "payment=()",
      "usb=()",
    ].join(", "),
  });

/** The HSTS value, for a request that arrived over TLS. */
export function hstsValue(maxAgeSeconds: number = HSTS_MAX_AGE_S): string {
  return `max-age=${maxAgeSeconds}; includeSubDomains`;
}

/**
 * Decides this request's hardening headers.
 *
 * Split from applying them for the reason `decideCsp` is: the decision is a pure
 * function of the request and is what the tests are about, while the application
 * is one loop over a record.
 */
export function decideHardeningHeaders(
  request: NextRequest,
): Readonly<Record<string, string>> {
  if (!isSecureRequest(request.nextUrl, request.headers)) {
    return STATIC_HARDENING_HEADERS;
  }

  return { ...STATIC_HARDENING_HEADERS, [HSTS_HEADER]: hstsValue() };
}

/**
 * Puts them on the response.
 *
 * `set`, not `append`: these are single-valued headers, and a second value is
 * how `X-Frame-Options: DENY, SAMEORIGIN` happens — which some browsers resolve
 * by honouring neither. Overwriting an upstream value is the intended behaviour
 * and the reason this runs last: this module is where the answer is decided, so
 * an earlier one is a draft.
 */
export function applyHardeningHeaders<T extends Response>(
  response: T,
  request: NextRequest,
): T {
  for (const [name, value] of Object.entries(decideHardeningHeaders(request))) {
    response.headers.set(name, value);
  }
  return response;
}
