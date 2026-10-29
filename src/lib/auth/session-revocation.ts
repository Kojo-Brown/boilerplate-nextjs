/**
 * Ending every session an account has, with no password involved.
 *
 * ## Why this is not part of the password change
 *
 * Because the password change cannot serve the accounts that need this most.
 * `changeUserPassword` verifies a current password first and answers
 * `no_password` when there is none to verify — which is every account that
 * signs in through Google. Until this module existed, such an account had no
 * way to revoke a stolen cookie at all: `SessionFamily` rows were written on
 * every sign-in, read on every request, and nothing but a password change ever
 * set `revokedAt`.
 *
 * ## Why it is a module and not two lines in the action
 *
 * The statement below is one `updateMany`, and it was exactly that inside
 * `signOutEverywhereAction` for one commit — see `docs/tdd-kata.md`, which is
 * the write-up of how this module arrived. Two gates refuse that placement and
 * both are right about it: rule R4 of `scripts/assert-tenant-isolation.ts`
 * requires every reach for the named unscoped client to carry the argument for
 * why its table is untenanted, and `src/actions/` is not where that argument is
 * reviewed. The second reason is the one that matters more day to day: with the
 * statement in the action, the only test that could assert it had to mock a
 * Prisma delegate and then assert the shape of a `where` clause through two
 * layers of hardening. Here `revokeEverySession` is parameterised over the
 * store, so the decisions and the statement are tested separately — the shape
 * `@/lib/auth/password-change` already uses.
 *
 * ## What it deliberately does not do
 *
 * **It spares nothing, the caller's own session included.** The same decision
 * the password change documents, and the same reason: sparing one family needs
 * the `sid` out of the caller's token, and this application keeps that claim
 * out of the session object handed to the client. Obtaining it would mean
 * widening what a session exposes in order to narrow what a revocation covers.
 * `signOutEverywhereAction` therefore signs this browser out immediately
 * afterwards, because a revocation is server-side state and cannot clear a
 * cookie.
 *
 * **It opens no transaction.** One statement is already atomic, and there is no
 * second write for it to be consistent with — which is the whole difference
 * from the password change, where the revocation has to commit with the new
 * hash or not at all.
 */
// Unscoped, and the name says so: `session_families` has no tenant column and
// no policy. A session belongs to a person across every workspace they are a
// member of, so scoping this write would end the sessions of one workspace and
// leave the rest running. The same table and the same argument as the
// revocation in `@/lib/auth/password-change`.
import { unscopedPrisma } from "@/lib/tenancy/client";
import { log } from "@/lib/logging/logger";

/** What this module writes, behind an interface so its tests own the write. */
export interface SessionRevocationStore {
  /**
   * Ends every family of `userId` that has not already ended, and answers how
   * many that was.
   *
   * `now` is a parameter rather than something the store reads off the clock,
   * for the reason the rest of this repository injects clocks: a timestamp a
   * test cannot name is a timestamp no test asserts.
   */
  revokeLiveFamilies(input: { userId: string; now: Date }): Promise<number>;
}

export interface SessionRevocationEvent {
  userId: string;
  /** How many families this call ended. Zero is a legitimate answer. */
  revoked: number;
}

export interface SessionRevocationDeps {
  store: SessionRevocationStore;
  report: (event: SessionRevocationEvent) => void;
  now(): Date;
}

/** The default store: one statement against `session_families`. */
export const prismaSessionRevocationStore: SessionRevocationStore = {
  async revokeLiveFamilies({ userId, now }) {
    const { count } = await unscopedPrisma.sessionFamily.updateMany({
      // `revokedAt: null` in the predicate rather than a blanket update, so a
      // family that ended in `TOKEN_REUSE` keeps saying so: the first reason is
      // the one an operator answering "why was I signed out?" needs.
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: "REVOKED_BY_USER" },
    });
    return count;
  },
};

/**
 * Writes the revocation to the stream the other session events use.
 *
 * `warn` and not `info`, matching `password_change`'s successful outcome: this
 * is rare, deliberate, and the kind of event somebody reconstructs a timeline
 * from afterwards. It is not an alert — the account's owner asked for it — so
 * `docs/log-redaction.md` leaves it off the table of lines worth paging on.
 *
 * The line carries an id and a count and has nothing else to carry: this
 * function is given no token, no cookie and no credential.
 */
export function reportSessionRevocation(event: SessionRevocationEvent): void {
  log("warn", "session_revocation", { ...event });
}

/**
 * Ends every live session for one account.
 *
 * Returns the number of families ended. Throws whatever the store throws:
 * nothing here can usefully recover from a failed revocation, and the caller
 * needs to know it did not happen — `signOutEverywhereAction` must not sign
 * this browser out after a failure, or the one session the person is holding
 * ends while every session they asked to end carries on.
 *
 * Reported after the write and never before, for the same reason: a line
 * saying five sessions were revoked, written beside a statement that threw,
 * is worse than no line at all.
 */
export async function revokeEverySession(
  input: { userId: string },
  deps: SessionRevocationDeps,
): Promise<number> {
  const revoked = await deps.store.revokeLiveFamilies({
    userId: input.userId,
    now: deps.now(),
  });

  deps.report({ userId: input.userId, revoked });

  return revoked;
}
