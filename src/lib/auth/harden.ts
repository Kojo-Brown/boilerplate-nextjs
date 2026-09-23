/**
 * The `jwt` callback, as a pure-ish function of its dependencies.
 *
 * Auth.js calls `callbacks.jwt` in three quite different situations and gives
 * the same signature to all of them:
 *
 *   1. **Sign-in.** `user` is set. There is no session yet; this is where one
 *      is minted and registered.
 *   2. **A request through the proxy.** Only `token` is set, and the token that
 *      comes back is re-encrypted and sent as a `Set-Cookie`. This is the only
 *      situation in which a rotated token can reach the browser, which is why
 *      rotation happens here and nowhere else.
 *   3. **A session read inside a Server Component.** Only `token` is set, and
 *      the `Set-Cookie` that Auth.js produces is *discarded* — `next-auth`'s
 *      RSC path reads the body and drops the headers, because a Server
 *      Component cannot write a cookie.
 *
 * Situation 3 is the trap. Rotating there would advance the registry to a `tid`
 * the browser never receives; the next request would present the old one, and
 * `classifyToken` would call it reuse and revoke the session. So rotation is
 * opt-in per call site — `mayRotate` — and the only caller that passes `true`
 * is `src/proxy.ts`, where the cookie demonstrably survives to the response.
 *
 * Returning `null` from this callback is how Auth.js is told there is no
 * session: it clears the cookie and `auth()` resolves to `null`. Every denial
 * below is a `null`.
 */
import {
  readSessionClaims,
  toEpochSeconds,
  writeSessionClaims,
} from "@/lib/auth/claims";
import {
  classifyToken,
  isAbsolutelyExpired,
  isRotationDue,
} from "@/lib/auth/policy";
import type { JWT } from "@auth/core/jwt";
import type { SessionRegistry } from "@/lib/auth/registry";

/**
 * Something worth a line in the log. Reported through a sink rather than
 * `console` directly so tests can assert on it without capturing stdout, and
 * so a deployment can route `token_reuse` somewhere a person will see it —
 * it is the one event here that means an incident rather than a policy.
 */
export type SessionSecurityEvent =
  | { type: "session_started"; sid: string; userId: string }
  | { type: "session_rotated"; sid: string }
  | { type: "rotation_lost_race"; sid: string }
  | { type: "token_reuse"; sid: string }
  | { type: "session_revoked"; sid: string }
  | { type: "session_unknown"; sid: string }
  | { type: "session_absolutely_expired"; sid: string }
  | { type: "token_unclaimed" };

export interface HardenDeps {
  registry: SessionRegistry;
  /** Injected so the boundary cases are table entries and not timing. */
  now(): Date;
  /** Injected for the same reason: a test needs to know the id it will get. */
  newId(): string;
  report(event: SessionSecurityEvent): void;
}

export interface HardenParams {
  token: JWT;
  /** Set by Auth.js on sign-in only. Its presence is what marks situation 1. */
  user?: { id?: string | undefined } | undefined;
  /**
   * Whether a token returned from here can actually reach the browser.
   * `true` only in `src/proxy.ts`.
   */
  mayRotate: boolean;
}

/**
 * The default reporter.
 *
 * `console.warn` rather than `error` for everything but reuse: a session
 * reaching its absolute deadline is the policy working, not a fault, and
 * paging on it would train people to ignore the channel that also carries
 * `token_reuse`.
 */
export function reportSessionEvent(event: SessionSecurityEvent): void {
  const line = JSON.stringify({ event: "auth.session", ...event });
  if (event.type === "token_reuse") console.error(line);
  else console.warn(line);
}

export async function hardenSessionToken(
  { token, user, mayRotate }: HardenParams,
  deps: HardenDeps,
): Promise<JWT | null> {
  const now = deps.now();

  // Situation 1: a sign-in. `user.id` is what the credentials provider and the
  // Prisma adapter both return; without it there is nobody to register the
  // session to, and a session that cannot be revoked per-user is the state
  // this module exists to end.
  if (user) {
    const userId = typeof user.id === "string" ? user.id : token.id;
    if (typeof userId !== "string" || userId.length === 0) return null;

    const sid = deps.newId();
    const tid = deps.newId();
    const seconds = toEpochSeconds(now);

    await deps.registry.start({ sid, userId, tid, now });
    deps.report({ type: "session_started", sid, userId });

    return writeSessionClaims(token, { sid, tid, sat: seconds, rat: seconds });
  }

  const claims = readSessionClaims(token);
  if (claims === null) {
    deps.report({ type: "token_unclaimed" });
    return null;
  }

  // Checked before the registry read, and deliberately so: it needs no row, so
  // it is the one bound that still holds when the database is unreachable.
  if (isAbsolutelyExpired(claims, now)) {
    deps.report({ type: "session_absolutely_expired", sid: claims.sid });
    await deps.registry.revoke(claims.sid, "ABSOLUTE_TIMEOUT", now);
    return null;
  }

  const record = await deps.registry.find(claims.sid);
  const standing = classifyToken(record, claims.tid, now);

  switch (standing.kind) {
    case "unknown":
      deps.report({ type: "session_unknown", sid: claims.sid });
      return null;

    case "revoked":
      deps.report({ type: "session_revoked", sid: claims.sid });
      return null;

    case "reuse":
      // The whole point. Two parties hold a cookie for this sign-in and there
      // is no way to tell which is the user, so neither keeps it: revoking the
      // family signs both out and makes the victim's next sign-in the thing
      // that restores service. Ending only the presented token would leave the
      // attacker's copy working if the attacker was the one who rotated.
      deps.report({ type: "token_reuse", sid: claims.sid });
      await deps.registry.revoke(claims.sid, "TOKEN_REUSE", now);
      return null;

    case "grace":
      // A token that was replaced moments ago, on a request that was already in
      // flight when the replacement was sent. Serve it, and do not rotate —
      // rotating from a `tid` that is no longer current would fail the
      // compare-and-swap anyway, and trying is a write per in-flight request.
      return token;

    case "current":
      break;
  }

  // Nothing to do: either this caller cannot deliver a rotated cookie, or the
  // token is not old enough to need one. No write on the common path — an
  // active session costs one indexed read per request and an UPDATE per
  // rotation interval, not an UPDATE per request.
  if (!mayRotate || !isRotationDue(claims, now)) return token;

  const next = deps.newId();
  const won = await deps.registry.rotate({
    sid: claims.sid,
    from: claims.tid,
    to: next,
    now,
  });

  if (!won) {
    // Another request rotated between this one's read and its write. Nothing is
    // wrong: the token being carried is now the *previous* one, inside its
    // grace window, and the browser will take the winner's cookie. Returning
    // the token unchanged is what keeps this request from setting a cookie that
    // contradicts the row.
    deps.report({ type: "rotation_lost_race", sid: claims.sid });
    return token;
  }

  deps.report({ type: "session_rotated", sid: claims.sid });
  return writeSessionClaims(token, {
    ...claims,
    tid: next,
    rat: toEpochSeconds(now),
  });
}
