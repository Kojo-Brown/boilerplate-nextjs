/**
 * The four claims that turn a session cookie into a member of a chain.
 *
 * Auth.js's JWT payload carries whatever the `jwt` callback puts there, and
 * this application already puts `id` and `role` in it. These four are what the
 * hardening in `@/lib/auth/harden` needs, and they are deliberately small and
 * deliberately *not* data: none of them says anything about the user, so a
 * cookie that leaks leaks no more than it did before.
 *
 * ## Why they are safe to trust
 *
 * Because they never travel outside the cookie, and the cookie is encrypted
 * (A256CBC-HS512) under a key derived from `NEXTAUTH_SECRET`. A claim read back
 * out of a token that decrypted is a claim this server wrote. That is what lets
 * `sat` enforce an absolute session lifetime with no database read at all — the
 * browser cannot move it.
 *
 * ## Why `tid` cannot do the same job
 *
 * `tid` identifies *which* token this is, and its meaning is entirely
 * relational: it is valid because the server's record says it is the current
 * one. Nothing inside the token can establish that, which is why reuse
 * detection needs `SessionFamily` and absolute expiry does not.
 *
 * ## Why it is `tid` and not `jti`
 *
 * Because `jti` is unusable here, and unusable in a way that no unit test can
 * show. `@auth/core`'s `encode` ends with
 *
 *     .setIssuedAt().setExpirationTime(now() + maxAge).setJti(crypto.randomUUID())
 *
 * so `iat`, `exp` **and `jti`** are overwritten on every single encode, after
 * the `jwt` callback has returned and with no way to opt out. A token id stored
 * under `jti` is therefore discarded on its way into the cookie and replaced
 * with a value nothing recorded — which means every request presents an id the
 * registry has never seen, `classifyToken` reads that as reuse, and the first
 * page load after signing in revokes the session and logs a security incident
 * against a user who did nothing.
 *
 * This was not reasoned out. It was written with `jti`, and the first sign-in
 * against a production build went `session_started` → `token_reuse` →
 * `session_revoked` in three log lines, with `GET /api/auth/session` answering
 * `null`. A test that mocks the encoder never encodes, so it would have passed
 * either way; this is the whole argument for exercising it against a running
 * server. `scripts/assert-session-hardening.ts` now fails on any claim name
 * `jose`'s `EncryptJWT` reserves, so the fix cannot be undone by someone
 * tidying an unfamiliar abbreviation into a standard one.
 */
import type { JWT } from "@auth/core/jwt";

/**
 * The session claims, in seconds since the epoch where they are times.
 *
 * Seconds rather than milliseconds because every other numeric claim in a JWT
 * is seconds (`exp`, `iat`, `nbf`), and one payload carrying both units is how
 * a comparison ends up a thousand times wrong in the safe-looking direction.
 */
export interface SessionClaims {
  /** The `SessionFamily.id` this token belongs to. Stable across rotations. */
  sid: string;
  /** This token's id. Changes on every rotation. */
  tid: string;
  /** Session authenticated at: the absolute-lifetime anchor. Never moves. */
  sat: number;
  /** Rotated at: when *this* token was minted. Moves on every rotation. */
  rat: number;
}

/** Seconds since the epoch, floored — the unit every claim here is in. */
export function toEpochSeconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

/**
 * Reads the session claims out of a token, or `null` if they are not all there.
 *
 * All four or none: a token carrying `sid` but no `sat` has no absolute
 * deadline, and one carrying `sat` but no `sid` cannot be revoked. Accepting a
 * partial set would mean accepting a token that one of the two defences cannot
 * see, which is the state this module exists to make impossible.
 *
 * The honest answer for a token minted before this feature shipped is therefore
 * `null`, and the caller treats that as "not a session". That signs every
 * outstanding session out once, at deploy. The alternative — adopting an
 * unclaimed token into a fresh family — would mean a stolen cookie could
 * *launder* itself into a valid, registered session simply by being presented,
 * which is the exact capability reuse detection exists to take away.
 */
export function readSessionClaims(token: JWT): SessionClaims | null {
  const { sid, tid, sat, rat } = token;

  if (typeof sid !== "string" || sid.length === 0) return null;
  if (typeof tid !== "string" || tid.length === 0) return null;
  if (!isFiniteSeconds(sat)) return null;
  if (!isFiniteSeconds(rat)) return null;

  return { sid, tid, sat, rat };
}

/**
 * `Number.isInteger` and not just `typeof === "number"`.
 *
 * `NaN`, `Infinity` and `1.5` are all `number`, and the first two make every
 * comparison in `@/lib/auth/policy` return `false` — which for
 * `isAbsolutelyExpired` means "not expired". A malformed numeric claim must not
 * be the one that fails open.
 */
function isFiniteSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Writes the claims onto a token, in place, and returns it. */
export function writeSessionClaims<T extends JWT>(
  token: T,
  claims: SessionClaims,
): T {
  token.sid = claims.sid;
  token.tid = claims.tid;
  token.sat = claims.sat;
  token.rat = claims.rat;
  return token;
}
