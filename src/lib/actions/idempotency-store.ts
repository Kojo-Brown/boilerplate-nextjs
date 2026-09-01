/**
 * The Postgres implementation of `IdempotencyStore`.
 *
 * Split from `@/lib/actions/idempotency` for the same reason
 * `define-authed-action` is split from `define-action`: this module imports
 * `@/lib/prisma`, and that drags the driver adapter and the connection pool
 * into the module graph of anything that touches it. The protocol has no
 * business carrying that, and keeping it out is what lets `idempotency.test.ts`
 * exercise the interleavings against an in-memory store.
 *
 * Everything here is one statement per operation, on purpose. The claim is the
 * only interesting one and it is interesting for a specific reason: it must
 * decide "am I first?" under concurrency, and every version of that question
 * built out of a read followed by a write is wrong in the same way — two
 * requests both read "no row", both write, and both run the handler. The unique
 * index on `(scope, action, key)` is the only thing in the system that can
 * settle it, so the claim is an `INSERT` whose *failure* carries the
 * information.
 *
 * One consequence of that, observed against a real Postgres rather than
 * inferred: `@/lib/prisma` configures `log: ["error"]`, and Prisma emits an
 * `Unique constraint failed` line *before* throwing. So every deduplicated
 * double-submit — the mechanism working exactly as intended — leaves an
 * error-shaped line in the server log. It is left alone here: the alternative
 * is either dropping Prisma's error log for the whole application, or dropping
 * the insert-first claim for a read-then-write that is racy by construction,
 * and a misleading log line is much the smallest of the three costs.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type {
  ClaimOutcome,
  ClaimRequest,
  IdempotencyRecord,
  IdempotencyStore,
} from "@/lib/actions/idempotency";

/** Prisma's code for a unique constraint violation. */
const UNIQUE_VIOLATION = "P2002";

/**
 * How many times `claim` will go round.
 *
 * Two, and the second exists for one narrow interleaving: this attempt's insert
 * loses the race, and the winner then *fails* and deletes its row before this
 * attempt reads it. The key is genuinely free at that point, so retrying the
 * insert is right. It cannot loop forever — the third answer would just be a
 * third racer, and reporting "in flight" to a caller who will retry is a better
 * outcome than spinning inside a request.
 */
const CLAIM_ATTEMPTS = 2;

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === UNIQUE_VIOLATION
  );
}

/**
 * The claim, as one insert plus — only when that insert loses — a takeover and
 * a read.
 *
 * The takeover is an `UPDATE … WHERE expiresAt < now`, which is a single
 * statement for both reclaimable cases, because `expiresAt` means the same
 * thing in both: a completed row past its retention window and an in-flight row
 * past its lease are equally not authoritative. Doing it as an update with the
 * condition in the `WHERE` rather than as "read, decide, write" keeps the
 * decision atomic — `count === 1` means this attempt is the one that took it.
 */
async function attemptClaim(
  request: ClaimRequest,
): Promise<ClaimOutcome | { kind: "vanished" }> {
  const { scope, action, key, fingerprint, token, now, leaseMs } = request;
  const expiresAt = new Date(now.getTime() + leaseMs);

  try {
    await prisma.idempotencyKey.create({
      data: {
        scope,
        action,
        key,
        fingerprint,
        claimToken: token,
        status: "IN_PROGRESS",
        expiresAt,
      },
    });
    return { kind: "claimed" };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  const { count } = await prisma.idempotencyKey.updateMany({
    where: { scope, action, key, expiresAt: { lt: now } },
    data: {
      fingerprint,
      claimToken: token,
      status: "IN_PROGRESS",
      // `DbNull` writes SQL NULL. `JsonNull` would write the JSON value `null`,
      // which reads back as a *result of null* — a completed row's worth of
      // meaning attached to a row that has not run yet.
      result: Prisma.DbNull,
      expiresAt,
    },
  });

  if (count === 1) return { kind: "claimed" };

  const existing = await prisma.idempotencyKey.findUnique({
    where: { scope_action_key: { scope, action, key } },
    select: { fingerprint: true, status: true, result: true },
  });

  if (!existing) return { kind: "vanished" };

  // Fingerprint before status, so a key reused for a different payload is a
  // conflict whether the first request has finished or not. The alternative —
  // reporting "in flight" and letting the caller retry into a conflict — tells
  // them to repeat a request that cannot ever succeed.
  if (existing.fingerprint !== fingerprint) return { kind: "conflict" };

  if (existing.status === "COMPLETED") {
    return { kind: "replay", result: existing.result };
  }

  return { kind: "in_flight" };
}

export const prismaIdempotencyStore: IdempotencyStore = {
  async claim(request: ClaimRequest): Promise<ClaimOutcome> {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const outcome = await attemptClaim(request);
      if (outcome.kind !== "vanished") return outcome;
    }

    // Still racing after two passes. "In flight" is the conservative answer:
    // it never runs the handler twice, and the caller's retry resolves it.
    return { kind: "in_flight" };
  },

  async complete(
    record: IdempotencyRecord,
    options: {
      token: string;
      result: unknown;
      now: Date;
      retentionMs: number;
    },
  ): Promise<void> {
    const { scope, action, key } = record;

    // `updateMany` with the token in the `WHERE`, not `update` by unique key.
    // An attempt whose lease expired while it was still running no longer owns
    // this row, and writing its result over the row a later attempt is holding
    // would replace a live claim with a receipt for work nobody is waiting on.
    // Matching nothing is the correct outcome there, and `updateMany` is the
    // form that expresses it — `update` would throw on the same condition.
    const { count } = await prisma.idempotencyKey.updateMany({
      where: { scope, action, key, claimToken: options.token },
      data: {
        status: "COMPLETED",
        // `?? DbNull` because a handler returning nothing stores SQL NULL
        // rather than failing Prisma's `InputJsonValue`, which rejects
        // `undefined` outright.
        result:
          (options.result as Prisma.InputJsonValue | undefined) ??
          Prisma.DbNull,
        expiresAt: new Date(options.now.getTime() + options.retentionMs),
      },
    });

    if (count === 0) {
      console.warn(
        `[idempotency] ${action}: claim was taken over before the result could be recorded; ` +
          "a later retry of this key will re-execute.",
      );
    }
  },

  async release(record: IdempotencyRecord, token: string): Promise<void> {
    const { scope, action, key } = record;

    // Same argument as `complete`, plus one: this runs on a failure path, and
    // `delete` throws on a row that is simply gone — turning a cleanup into a
    // second error stacked on the one being reported.
    await prisma.idempotencyKey.deleteMany({
      where: { scope, action, key, claimToken: token, status: "IN_PROGRESS" },
    });
  },
};
