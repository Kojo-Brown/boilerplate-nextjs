/**
 * The one predicate every redirect target in this application goes through.
 *
 * ## Why this is not a one-line check
 *
 * A redirect destination that came out of a request is the classic open
 * redirect: the browser is sent somewhere an attacker chose, from a URL on this
 * origin, with this origin's TLS certificate and this origin's name in the
 * address bar until the hop completes. That is a phishing primitive, and it is
 * also how a sign-in flow leaks — `/login?callbackUrl=…` is a link a victim will
 * click precisely because it starts with the right hostname.
 *
 * The obvious guard, `destination.startsWith("/")`, does not work, and the
 * reason is in the URL parser rather than in anything about this application.
 * Measured with Node's `URL` against a `https://app.example/login` base:
 *
 * ```
 * "//evil.example"     -> https://evil.example/      accepted by startsWith("/")
 * "/\\evil.example"    -> https://evil.example/      accepted by startsWith("/")
 * "/\t/evil.example"   -> https://evil.example/      accepted by startsWith("/")
 * "//"                 -> throws "Invalid URL"       accepted by startsWith("/")
 * ```
 *
 * The first is a protocol-relative URL: to a browser it is an absolute URL whose
 * scheme is inherited, and it begins with a slash. The second is the same trick
 * spelled with a backslash, which WHATWG URL parsing normalises to `/` before it
 * decides where the authority ends. The third is the second one hidden behind a
 * tab, because tabs, newlines and carriage returns are stripped from a URL
 * *before* parsing — so a control character is not merely a header-injection
 * concern, it is an authority-confusion one. The fourth is not off-origin at all;
 * it is a `TypeError` thrown out of whatever composed the response, which for a
 * proxy means a 500 on a URL any caller can produce.
 *
 * So the check is a small allowlist of shape, not a denylist of hostnames, and
 * it lives in one module because the repository has already learned the cost of
 * two copies: `@/lib/preview/token` had this right, with a comment saying in as
 * many words that `startsWith("/")` is not enough, while `@/auth.config`
 * fourteen files away was doing exactly that to the `callbackUrl` it had put in
 * the URL itself.
 *
 * Pure strings, no imports: `@/auth.config` is the deliberately import-light
 * half of the Auth.js split and this has to be callable from it.
 */

/** Where an unusable destination goes when the caller has nowhere better. */
export const DEFAULT_REDIRECT_PATH = "/";

/**
 * Whether `candidate` is a path this application will redirect a browser to.
 *
 * True only for a site-relative path: one leading `/`, no second authority, no
 * scheme, no control characters. A query string and a fragment are fine — they
 * cannot move the origin — and a path that matches no route is *safe* even
 * though it is useless, which is the distinction this function is drawing. It
 * answers "can this leave the origin?", not "does this exist?"; a caller that
 * wants the second question answered has the router for it, and in this codebase
 * a safe-but-unrouted path renders the 404 page like any other.
 */
export function isSiteRelativePath(candidate: string): boolean {
  if (!candidate.startsWith("/")) return false;

  // A second slash — literal, or spelled as a backslash the parser folds into
  // one — starts an authority, and the authority is the origin.
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return false;

  // Stripped from the URL before it is parsed, so `/\t/evil.example` is
  // `//evil.example` by the time anything looks at it — and a newline in a
  // `Location` header is response splitting besides. None of them has any
  // business in a path this application would mint.
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return false;

  return true;
}

/**
 * `candidate` if it is site-relative, otherwise `fallback`.
 *
 * The shape every caller here actually wants: a redirect has to go *somewhere*,
 * so the interesting question is never "is this valid" on its own but "what do
 * we do instead". Taking the fallback as a required argument is what stops that
 * decision from being made by omission at each call site — and `fallback` is
 * asserted rather than checked, because a fallback is a literal in the source,
 * so a bad one is a bug to fix now rather than a runtime branch to carry.
 */
export function safeRedirectPath(
  candidate: string | null | undefined,
  fallback: string = DEFAULT_REDIRECT_PATH,
): string {
  if (!isSiteRelativePath(fallback)) {
    throw new Error(
      `safeRedirectPath fallback "${fallback}" is not a site-relative path.`,
    );
  }

  if (typeof candidate !== "string") return fallback;
  return isSiteRelativePath(candidate) ? candidate : fallback;
}
