/**
 * The two cookies bucketing needs, and what goes in them.
 *
 * ## Why there are two
 *
 * The visitor id is the input to the hash; the assignments are its output. They
 * are separated because they have different lifetimes and different failure
 * modes. Losing the id re-buckets someone into a new cohort. Losing the
 * assignments re-derives them — identically, as long as the weights and salt
 * have not changed since.
 *
 * ## Why the output is stored at all, when the hash is deterministic
 *
 * This is the part that is usually skipped, and it is the whole meaning of
 * "cookie-stable". A hash is stable with respect to the visitor and unstable
 * with respect to the *experiment*: change a weight from 50/50 to 70/30 and
 * every bucket boundary moves, so a fifth of the people already in the
 * treatment silently become controls. They have seen the treatment. They may
 * have converted on it. Now their sessions are counted in the other arm, and
 * the experiment is not measuring what it says it is.
 *
 * Nothing about that fails. No error is raised, no page breaks, and the
 * dashboard keeps filling in. Persisting the assignment is what makes a weight
 * change apply to new visitors only, which is the only way a weight change is
 * safe to make while an experiment is running.
 *
 * ## Format
 *
 * `experiment:variant|experiment:variant`. Not JSON, not base64: the values are
 * `[a-z0-9-]` by `ID_PATTERN`, so there is nothing to escape, the cookie stays
 * legible in a devtools panel, and parsing is two `split`s that cannot throw.
 * A malformed entry is dropped rather than rejected — see `parseAssignments`.
 */
import { ID_PATTERN } from "@/lib/experiments/definitions";

/** The visitor id. Not a user id: see the note on `mintVisitorId`. */
export const VISITOR_COOKIE = "bkt_vid";

/** The resolved assignments, so a weight change does not re-bucket anyone. */
export const ASSIGNMENT_COOKIE = "bkt_exp";

/**
 * One year.
 *
 * Long enough that an experiment running for a quarter sees the same people
 * throughout, which is the point. Also long enough to be a tracking identifier
 * in the sense every privacy regime means it — see docs/experiments.md, which
 * says plainly that this is a first-party cookie with no personal data in it
 * and still is not automatically "strictly necessary" under the ePrivacy
 * directive. A deployment with a consent banner should mint these behind it.
 */
export const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export const ENTRY_SEPARATOR = "|";
export const FIELD_SEPARATOR = ":";

/**
 * A fresh visitor id.
 *
 * `crypto.randomUUID()` rather than a counter, a timestamp or a hash of the
 * request: it is available in every runtime this application can run in, needs
 * no state shared between processes, and — unlike anything derived from the
 * request — carries no IP address, no user agent and no arrival time. The id is
 * a random label with nothing recoverable in it, which is what makes the cookie
 * defensible to write and cheap to discard.
 *
 * It is deliberately not the session's user id. Bucketing must work for logged
 * out visitors, must survive a login, and must not change when one person signs
 * in as another on a shared machine — and a user id fails the first, makes the
 * second a re-bucket, and turns the third into cross-account leakage of
 * whatever the assignment implies.
 */
export function mintVisitorId(): string {
  return crypto.randomUUID();
}

/**
 * Whether a cookie value is a visitor id this application minted.
 *
 * The value arrives from the client and is used as hash input, so the only
 * thing that actually matters is that it is bounded and has no separators in
 * it. Checking the UUID shape gets that for free and has a second effect worth
 * having: a value that is *not* one of ours — a stale format, another app's
 * cookie on a shared domain, something a proxy rewrote — is replaced rather
 * than hashed, so the population being bucketed is the population this code
 * created.
 */
const VISITOR_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isVisitorId(value: string): boolean {
  return VISITOR_ID_PATTERN.test(value);
}

/**
 * Assignments as `Map<experimentId, variantId>`.
 *
 * Never throws and never rejects the whole cookie over one bad entry. A cookie
 * is client-supplied and survives deploys, so it will eventually contain an
 * experiment that has been retired, a variant that has been renamed, and — if
 * anything ever shares this domain — something else entirely. Treating any of
 * that as an error means an exception on the request path of every page; the
 * caller's own reconciliation in `@/lib/experiments/assignment` already has to
 * handle "this entry no longer means anything", so unreadable and obsolete
 * entries arrive there as the same thing: absent.
 *
 * A duplicate key keeps the *first* occurrence, so a second entry appended by
 * anything other than this module cannot displace the assignment already made.
 */
export function parseAssignments(raw: string | undefined): Map<string, string> {
  const assignments = new Map<string, string>();
  if (!raw) return assignments;

  for (const entry of raw.split(ENTRY_SEPARATOR)) {
    const parts = entry.split(FIELD_SEPARATOR);
    if (parts.length !== 2) continue;

    const [experimentId, variantId] = parts;
    if (experimentId === undefined || variantId === undefined) continue;
    if (!ID_PATTERN.test(experimentId) || !ID_PATTERN.test(variantId)) continue;
    if (assignments.has(experimentId)) continue;

    assignments.set(experimentId, variantId);
  }

  return assignments;
}

/** The inverse of {@link parseAssignments}, with entries in the order given. */
export function serialiseAssignments(
  assignments: Iterable<readonly [string, string]>,
): string {
  return [...assignments]
    .map(([experimentId, variantId]) =>
      [experimentId, variantId].join(FIELD_SEPARATOR),
    )
    .join(ENTRY_SEPARATOR);
}

export interface CookieAttributes {
  readonly httpOnly: true;
  readonly sameSite: "lax";
  readonly path: "/";
  readonly maxAge: number;
  readonly secure: boolean;
}

/**
 * The attributes both cookies are written with.
 *
 * `httpOnly` because nothing in the browser needs to read them: the variant a
 * visitor is in is decided in the proxy and rendered by the server, so client
 * JavaScript reading the cookie would only be able to disagree with the page it
 * is on. It also means an XSS cannot quietly rewrite someone's cohort.
 *
 * `sameSite: "lax"` rather than `strict`: `strict` withholds the cookie on
 * every cross-site navigation, which is precisely the traffic an experiment is
 * usually measuring — the visitor arriving from an ad, a search result or a
 * link. They would be minted a new id on arrival, bucketed afresh, and counted
 * as a new visitor every time they came back through the same link.
 *
 * `secure` is conditional on the request being HTTPS rather than hard-coded,
 * because a `Secure` cookie set over `http://localhost` is discarded by the
 * browser without a word — which would make every local page view a new
 * visitor, and make the one thing this module exists to provide untestable by
 * hand.
 */
export function cookieAttributes(secure: boolean): CookieAttributes {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    secure,
  };
}

/** Whether a request arrived over HTTPS, including behind a terminating proxy. */
export function isSecureRequest(url: URL, headers: Headers): boolean {
  if (url.protocol === "https:") return true;
  // A terminating proxy rewrites the scheme; `x-forwarded-proto` is how it says
  // so. Taking the first entry is correct here and wrong in
  // `@/lib/rate-limit/client-identity` for opposite reasons: a forged `https`
  // makes a cookie *more* restrictive, so the failure direction of trusting it
  // is a cookie the client does not get back, not one an attacker can steal.
  const forwarded = headers.get("x-forwarded-proto");
  return forwarded?.split(",")[0]?.trim().toLowerCase() === "https";
}
