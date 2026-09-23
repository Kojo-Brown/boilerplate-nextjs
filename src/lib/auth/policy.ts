/**
 * The four durations, the ordering they have to satisfy, and the one decision
 * that reads a `SessionFamily` row.
 *
 * Everything here is pure: no clock, no database, no Auth.js. That is what
 * makes the interesting cases — a token presented one second past its grace
 * window, two requests racing to rotate the same token — testable as table
 * entries rather than as timing.
 */
import type { SessionClaims } from "@/lib/auth/claims";
import type { SessionFamilyRecord } from "@/lib/auth/registry";

/**
 * The sliding idle window: how long a session survives with no requests.
 *
 * This is Auth.js's `session.maxAge`, which is also the JWT's `exp` and the
 * cookie's `Expires`, and it is refreshed on every request. Auth.js's own
 * default is **30 days**, which in a boilerplate that ships a Dockerfile and a
 * Vercel config means a cookie captured once is a login for a month — and,
 * because the window slides, for a month after the *last* time the thief used
 * it, which is to say indefinitely.
 *
 * A day is the shortest value that does not sign people out over lunch.
 */
export const SESSION_IDLE_MAX_AGE_S = 60 * 60 * 24;

/**
 * The absolute lifetime: how long a session survives however active it is.
 *
 * This is the bound the sliding window cannot express, and the reason the `sat`
 * claim exists. Without it there is no answer to "when does this sign-in end?"
 * other than "when it stops being used", and a session that is being used by
 * somebody else never stops being used.
 *
 * Enforced from the claim rather than from the row, so it holds even if the
 * registry is unreachable: `sat` is inside the encrypted token and the browser
 * cannot move it.
 */
export const SESSION_ABSOLUTE_MAX_AGE_S = 60 * 60 * 24 * 7;

/**
 * How often the token is replaced while a session is in use.
 *
 * Rotation is what turns a stolen cookie from a credential into a race. The
 * thief's copy stops working at the victim's next rotation, and the attempt to
 * use it afterwards is what `SessionFamily` notices. Shorter is stronger and
 * costs one `UPDATE` per interval per active session; fifteen minutes is a
 * write every fifteen minutes for someone who is actually browsing, and bounds
 * the useful life of a captured cookie to the same.
 */
export const SESSION_ROTATION_INTERVAL_S = 60 * 15;

/**
 * How long the replaced token keeps working after a rotation.
 *
 * Purely a concurrency allowance, and the single most delicate number here. A
 * rotation is one `Set-Cookie` on one response; every request that was already
 * in flight still carries the old token, and this application issues plenty at
 * once — parallel route slots, streamed Suspense boundaries, prefetches the
 * router started before the user clicked. Without a window, opening
 * `/dashboard` would rotate on the document request and then flag its own
 * sub-requests as reuse, revoking the session the user just used.
 *
 * Thirty seconds is far longer than any of those take and far shorter than an
 * attacker's replay is likely to be. It must stay well below
 * `SESSION_ROTATION_INTERVAL_S`, or two windows could overlap and a token could
 * be "previous" for two different rotations at once.
 */
export const SESSION_ROTATION_GRACE_S = 30;

/**
 * What a presented `tid` turns out to be.
 *
 * `unknown` and `revoked` are separate outcomes even though both deny the
 * request, because they are different events: the first is a row that is gone
 * (swept, or never written), the second is a row that says why it ended.
 */
export type TokenStanding =
  /** The token the registry says is current. */
  | { kind: "current" }
  /** The token that was just replaced, still inside its grace window. */
  | { kind: "grace" }
  /**
   * Neither — including the previous token *after* its window. Two parties
   * hold cookies for this sign-in and there is no way to tell which one is
   * the user, so the family goes.
   */
  | { kind: "reuse" }
  /** The family exists and has already ended. */
  | { kind: "revoked" }
  /** No row. Nothing can vouch for this token. */
  | { kind: "unknown" };

/**
 * Decides what a presented token is, given the family's row.
 *
 * Order matters and is not the order the cases are written in above:
 * `revoked` is checked before the id comparisons, so that a token which is
 * still nominally "current" on a family that has been signed out is denied
 * rather than accepted. Revocation has to outrank currency or "sign out
 * everywhere" would only take effect at the next rotation.
 */
export function classifyToken(
  record: SessionFamilyRecord | null,
  tid: string,
  now: Date,
): TokenStanding {
  if (record === null) return { kind: "unknown" };
  if (record.revokedAt !== null) return { kind: "revoked" };

  if (record.currentTokenId === tid) return { kind: "current" };

  if (
    record.previousTokenId === tid &&
    record.previousValidUntil !== null &&
    now.getTime() <= record.previousValidUntil.getTime()
  ) {
    return { kind: "grace" };
  }

  return { kind: "reuse" };
}

/**
 * Whether this token has been carried for longer than the rotation interval.
 *
 * Reads `rat`, not `sat`: the question is the age of *this* token, not of the
 * session. A session that has been rotating for six days is still due again
 * fifteen minutes after its last rotation.
 */
export function isRotationDue(claims: SessionClaims, now: Date): boolean {
  return nowSeconds(now) - claims.rat >= SESSION_ROTATION_INTERVAL_S;
}

/**
 * Whether the session is past its absolute deadline.
 *
 * `>=` rather than `>`: a session whose deadline is exactly now is over. The
 * boundary is arbitrary but it has to be written down somewhere, and the
 * inclusive form is the one that never serves a request at `sat + max`.
 */
export function isAbsolutelyExpired(claims: SessionClaims, now: Date): boolean {
  return nowSeconds(now) - claims.sat >= SESSION_ABSOLUTE_MAX_AGE_S;
}

/** The absolute deadline as a `Date`, for the row that mirrors `sat`. */
export function absoluteDeadline(startedAt: Date): Date {
  return new Date(startedAt.getTime() + SESSION_ABSOLUTE_MAX_AGE_S * 1000);
}

/** When a token replaced now stops being accepted. */
export function graceDeadline(rotatedAt: Date): Date {
  return new Date(rotatedAt.getTime() + SESSION_ROTATION_GRACE_S * 1000);
}

function nowSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}
