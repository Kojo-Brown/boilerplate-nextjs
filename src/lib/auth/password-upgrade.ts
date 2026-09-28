/**
 * Re-hashing a password at the current policy, on the one request that can.
 *
 * ## Why sign-in is the only place this can happen
 *
 * A password hash cannot be upgraded in a migration. The stored value is a
 * one-way function of the plaintext, so raising the cost means re-deriving
 * from the plaintext, and the plaintext exists in this process for exactly one
 * request in an account's life: the one where somebody typed it. Everything
 * else — a background job, a schema migration, an admin tool — has the hash
 * and nothing else, and can do no more with it than compare.
 *
 * So `verifyPassword` returning `true` is the signal, and it is a perishable
 * one. That is the whole shape of this module: it runs after the check has
 * already succeeded, while the credential is still in scope, and it is the
 * only caller in the application that will ever be holding both halves.
 *
 * ## Why it is a compare-and-set
 *
 * The write is `UPDATE users SET password = :to WHERE id = :id AND password =
 * :from`, not a `SET` on the id alone, and the condition is doing real work.
 * Two sign-ins for the same account can be in flight at once — the same
 * person on a phone and a laptop, or a form resubmission — and both will read
 * the same stale hash, both will find it below policy, and both will derive a
 * replacement from different salts. Unconditional writes make that a
 * last-writer-wins race between two equally valid values, which is harmless.
 *
 * The case that is not harmless is a password *change* landing between the
 * verification and this write. That request set a hash for a new password;
 * this one would overwrite it with a re-derivation of the old one, silently
 * reverting the change — and the user would be left with a password they
 * believe they have replaced, which is the exact failure a password change is
 * usually a response to. Naming the hash this call verified against is what
 * makes that a no-op instead: the row no longer matches, nothing is written,
 * and the upgrade happens on the next sign-in with the new credential.
 *
 * ## Why nothing here can fail a sign-in
 *
 * The password was already checked. A failure in this module means the hash
 * stayed at its old cost, which is where it was a moment ago and is not a
 * reason to refuse someone entry — so the database error is caught, reported
 * and swallowed. The inverse policy would turn a transient write failure into
 * an outage of the login page, which is a self-inflicted denial of service in
 * the name of a cost parameter.
 */
import { log } from "@/lib/logging/logger";
import { unscopedPrisma } from "@/lib/tenancy/client";
import {
  hashPassword,
  needsRehash,
  PASSWORD_HASH_POLICY,
  type ScryptParameters,
} from "@/lib/password";

/** What happened, for the caller's log and for the tests. */
export type PasswordUpgradeOutcome =
  /** The stored hash already meets policy. The common case, and free. */
  | "current"
  /** Re-derived and written. */
  | "upgraded"
  /** The row changed under us — a password change won. Deliberately not an error. */
  | "superseded"
  /** The write threw. The old hash stands. */
  | "failed";

export interface PasswordUpgradeEvent {
  outcome: PasswordUpgradeOutcome;
  userId: string;
  /** Present only on `failed`. See `describeError` for what it may contain. */
  error?: string | undefined;
}

/**
 * An error's name and code, and deliberately not its message.
 *
 * This is the one field on the event that comes from outside, and the call it
 * describes is `UPDATE users SET password = $1 WHERE id = $2 AND password =
 * $3`. Database drivers routinely put the failing statement and its bound
 * parameters into the message they throw — so carrying the message through
 * would mean a connection hiccup writes a freshly derived password hash into
 * the application log, which is a worse outcome than the failure being
 * reported. The name, plus Prisma's error code when there is one, separates a
 * connection failure from a constraint violation and carries no operand.
 *
 * Redacting log output in general is its own spec item. This function is not
 * that: it does not try to recognise a secret, it just never has one.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? `${error.name} (${code})` : error.name;
}

/** The one write this module performs, behind an interface so tests can own it. */
export interface PasswordStore {
  /**
   * Replaces `from` with `to` for `userId`, only if the row still holds
   * `from`. Returns the number of rows changed: 1 on success, 0 when another
   * write got there first.
   */
  replaceHash(input: {
    userId: string;
    from: string;
    to: string;
  }): Promise<number>;
}

export interface PasswordUpgradeDeps {
  store: PasswordStore;
  report: (event: PasswordUpgradeEvent) => void;
  /** The policy to measure against and rehash to. One value, read once. */
  policy?: ScryptParameters | undefined;
}

/**
 * `updateMany` and not `update`, because the condition is the point.
 *
 * Prisma's `update` takes a unique `where` and throws `P2025` when it matches
 * nothing, so expressing the compare-and-set through it would mean catching an
 * exception to detect the ordinary case of having lost a race. `updateMany`
 * accepts the non-unique predicate and reports a count, which is the same
 * statement with the outcome as a return value.
 */
export const prismaPasswordStore: PasswordStore = {
  async replaceHash({ userId, from, to }) {
    // Unscoped, and the import says so. `users` has no tenant column and no
    // policy — a person is a member of several workspaces rather than owned by
    // one — which is the same reason registration writes the first hash
    // through this client. See docs/multi-tenancy.md.
    const { count } = await unscopedPrisma.user.updateMany({
      where: { id: userId, password: from },
      data: { password: to },
    });
    return count;
  },
};

/** Writes an upgrade to the same stream the session events use. */
export function reportPasswordUpgrade(event: PasswordUpgradeEvent): void {
  // `current` is every sign-in once the fleet has caught up, so logging it
  // would be one line per login saying nothing happened.
  if (event.outcome === "current") return;

  log(event.outcome === "failed" ? "error" : "warn", "password_rehash", {
    ...event,
  });
}

/**
 * Brings one account's hash up to policy, if it is behind and nothing else
 * has changed it. Never throws.
 *
 * `storedHash` is the value this call's verification ran against, and it is
 * what the write is conditional on — so it has to be the string that came out
 * of the same read, not a re-read of the row.
 */
export async function upgradePasswordHash(
  input: { userId: string; storedHash: string; password: string },
  deps: PasswordUpgradeDeps,
): Promise<PasswordUpgradeOutcome> {
  const policy = deps.policy ?? PASSWORD_HASH_POLICY;

  if (!needsRehash(input.storedHash, policy)) {
    deps.report({ outcome: "current", userId: input.userId });
    return "current";
  }

  try {
    // The same `policy` object `needsRehash` was given. Reading the module
    // constant again here would let the two disagree if it ever became
    // anything but a constant, and the disagreement's shape is an upgrade loop:
    // rehash to a value that the next sign-in also finds wanting.
    const replacement = await hashPassword(input.password, policy);
    const changed = await deps.store.replaceHash({
      userId: input.userId,
      from: input.storedHash,
      to: replacement,
    });

    const outcome: PasswordUpgradeOutcome =
      changed === 1 ? "upgraded" : "superseded";
    deps.report({ outcome, userId: input.userId });
    return outcome;
  } catch (error) {
    deps.report({
      outcome: "failed",
      userId: input.userId,
      error: describeError(error),
    });
    return "failed";
  }
}
