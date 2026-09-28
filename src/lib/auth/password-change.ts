/**
 * Changing a password, and ending every session that was opened with the old
 * one.
 *
 * ## Why the two writes are one write
 *
 * A password change that leaves the old sessions alive changes almost nothing.
 * Under a JWT strategy a session is a cookie plus a `SessionFamily` row, and
 * neither of them mentions the password — so the copy of the cookie somebody
 * else is holding goes on working until its absolute deadline, which is a week.
 * The reason people change a password is that they think somebody has it, and
 * the thing they believe they have just done is exactly the thing that does not
 * happen by itself.
 *
 * So the revocation is not a follow-up to the change, it is part of it, and
 * `replaceHashAndRevokeSessions` is one method rather than two because the two
 * statements have to commit together. Written as a `PasswordStore.replaceHash`
 * followed by a registry call — which is what `docs/session-hardening.md` used
 * to sketch — there is a window between them: the hash lands, the revocation
 * fails on a connection error, and the account is left with a password its
 * owner did not choose an hour ago and sessions they believe they closed. The
 * user cannot retry their way out of it either, because the current password
 * they would have to type is no longer current. Inside one transaction the
 * failure mode is a change that did not happen, which is a failure the caller
 * can report and the user can repeat.
 *
 * That is also why the operation is not a method on `SessionRegistry`. Its
 * implementation is one statement against `session_families`, so it would fit
 * there — but it has to run on the transaction that is writing `users`, and an
 * interface whose methods each bring their own client cannot join one.
 *
 * ## Why nothing here is swallowed
 *
 * The exact opposite of `@/lib/auth/password-upgrade`, and for the same reason
 * stated the other way round. There, the write is something the server decided
 * to do on a request the user made for another purpose, so a failure must not
 * cost them their sign-in. Here the write *is* the request. A database error
 * has to reach the caller, because the alternative is telling somebody their
 * password has changed when it has not.
 *
 * ## Why the write is still a compare-and-set
 *
 * Same argument as the rehash, arrived at from the other end: the condition
 * names the hash this call verified against, so two changes racing cannot
 * interleave into a row that matches neither, and a verify-then-rehash landing
 * in the middle cannot overwrite the new password with a re-derivation of the
 * old one. Losing the swap is reported rather than retried — a retry would need
 * the plaintext of whatever won, which this request does not have.
 */
import { log } from "@/lib/logging/logger";
import { unscopedPrisma } from "@/lib/tenancy/client";
import {
  hashPassword,
  verifyPassword,
  PASSWORD_HASH_POLICY,
  type ScryptParameters,
} from "@/lib/password";

/**
 * What happened. A union rather than a boolean plus a message, because every
 * refusal below is a different thing for the caller to say and three of them
 * belong against a specific field.
 */
export type PasswordChangeOutcome =
  /** Written, and `sessionsRevoked` families ended with it. */
  | { kind: "changed"; sessionsRevoked: number }
  /** The account has no password: it signs in through an OAuth provider only. */
  | { kind: "no_password" }
  /** `currentPassword` does not verify against the stored hash. */
  | { kind: "incorrect" }
  /** The new password is the current one, so there is nothing to change. */
  | { kind: "reused" }
  /** The row stopped holding the verified hash before the write landed. */
  | { kind: "superseded" };

export interface PasswordChangeEvent {
  outcome: PasswordChangeOutcome["kind"];
  userId: string;
  /** Present on `changed` only. */
  sessionsRevoked?: number | undefined;
}

/**
 * The two statements this module performs, behind an interface so its tests own
 * them rather than mocking a database.
 */
export interface PasswordChangeStore {
  /**
   * The user's stored hash, or `null` when there is no row or the row has no
   * password. The two are the same answer here: in both cases there is no
   * credential to verify against and nothing to replace.
   */
  findPasswordHash(userId: string): Promise<string | null>;

  /**
   * Replaces `from` with `to` and revokes every live session for the user, in
   * one transaction.
   *
   * Returns the number of sessions revoked, or `null` when the row no longer
   * held `from` — in which case nothing was written and no session was ended.
   */
  replaceHashAndRevokeSessions(input: {
    userId: string;
    from: string;
    to: string;
    now: Date;
  }): Promise<number | null>;
}

export interface PasswordChangeDeps {
  store: PasswordChangeStore;
  report: (event: PasswordChangeEvent) => void;
  /** Injected so the revocation timestamp is a value a test can assert on. */
  now(): Date;
  /** What the new hash is derived at. Defaults to the current policy. */
  policy?: ScryptParameters | undefined;
}

/** The default store: `users` and `session_families`, in one transaction. */
export const prismaPasswordChangeStore: PasswordChangeStore = {
  async findPasswordHash(userId) {
    // Unscoped, and the import says so — the same client and the same argument
    // as `@/lib/auth/password-upgrade`: a password belongs to a person, not to
    // one of the workspaces they are a member of, and `users` has neither a
    // tenant column nor a policy. See docs/multi-tenancy.md.
    const row = await unscopedPrisma.user.findUnique({
      where: { id: userId },
      select: { password: true },
    });
    return row?.password ?? null;
  },

  async replaceHashAndRevokeSessions({ userId, from, to, now }) {
    return unscopedPrisma.$transaction(async (tx) => {
      // `updateMany` for the condition, not the cardinality: the predicate is
      // the id *and* the verified hash, so the database decides whether this
      // call still has the right to write. `update` would take a unique `where`
      // and throw `P2025` when it matched nothing, which would mean catching an
      // exception to detect having lost a race.
      const { count } = await tx.user.updateMany({
        where: { id: userId, password: from },
        data: { password: to },
      });
      if (count !== 1) return null;

      // Every live family, including the one that made this request. See
      // `docs/session-hardening.md` for why this does not spare the caller's
      // own session: "everywhere" with an exception is a rule with a path on
      // which a session survives, and sparing one would mean reading the `sid`
      // out of the caller's token — a claim this application deliberately keeps
      // out of the session object handed to the client.
      //
      // `revokedAt: null` in the predicate rather than a blanket update, so a
      // family that ended in `TOKEN_REUSE` keeps saying so: the first reason is
      // the one an operator answering "why was I signed out?" needs.
      const { count: revoked } = await tx.sessionFamily.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: "REVOKED_BY_USER" },
      });

      return revoked;
    });
  },
};

/**
 * Writes a password change to the same stream the session events use.
 *
 * Every outcome is logged, including the refusals and including the ordinary
 * success — which is the opposite of `reportPasswordUpgrade`, where `current`
 * is suppressed because it is one line per sign-in saying nothing happened. A
 * password change is rare and is the kind of event somebody reconstructs a
 * timeline from afterwards, and `incorrect` is a signed-in caller guessing at
 * the password of the account they are already in.
 *
 * The event carries an id, an outcome and a count. It cannot carry either
 * password, because it is not given them.
 */
export function reportPasswordChange(event: PasswordChangeEvent): void {
  log(event.outcome === "changed" ? "warn" : "error", "password_change", {
    ...event,
  });
}

/**
 * Verifies the current password, replaces it, and ends every session.
 *
 * Throws whatever the store throws: see the header for why this one does not
 * swallow a database error.
 */
export async function changeUserPassword(
  input: { userId: string; currentPassword: string; newPassword: string },
  deps: PasswordChangeDeps,
): Promise<PasswordChangeOutcome> {
  const { userId } = input;
  const settle = (outcome: PasswordChangeOutcome): PasswordChangeOutcome => {
    deps.report({
      outcome: outcome.kind,
      userId,
      ...(outcome.kind === "changed" && {
        sessionsRevoked: outcome.sessionsRevoked,
      }),
    });
    return outcome;
  };

  const stored = await deps.store.findPasswordHash(userId);
  // Checked before the derivation below, so an OAuth-only account is refused
  // without paying for a hash it has no hope of matching.
  if (stored === null) return settle({ kind: "no_password" });

  if (!(await verifyPassword(input.currentPassword, stored))) {
    return settle({ kind: "incorrect" });
  }

  // After the verification, so that a caller who typed their current password
  // wrong *and* asked for the same one back is told the first thing rather than
  // the second. A plain comparison is enough: `currentPassword` has just been
  // shown to produce `stored`, so the two plaintexts being equal is exactly the
  // condition "the new password is the one already stored". Both values came
  // from the same submission, so there is nothing here for a timing comparison
  // to protect.
  if (input.newPassword === input.currentPassword) {
    return settle({ kind: "reused" });
  }

  const replacement = await hashPassword(
    input.newPassword,
    deps.policy ?? PASSWORD_HASH_POLICY,
  );

  const sessionsRevoked = await deps.store.replaceHashAndRevokeSessions({
    userId,
    from: stored,
    to: replacement,
    now: deps.now(),
  });

  if (sessionsRevoked === null) return settle({ kind: "superseded" });

  return settle({ kind: "changed", sessionsRevoked });
}
