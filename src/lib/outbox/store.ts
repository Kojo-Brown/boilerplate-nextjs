/**
 * The Postgres implementation of `OutboxRelayStore`.
 *
 * Split from `@/lib/outbox/relay` for the reason `idempotency-store` is split
 * from `idempotency`: this module imports `@/lib/prisma`, which drags the
 * driver adapter and the connection pool into the module graph of anything that
 * touches it, and the protocol has no business carrying that.
 *
 * Every write here carries `claimToken` in its `WHERE` and every one is an
 * `updateMany` rather than an `update`. Both are the same argument the
 * idempotency store makes: an attempt whose lease expired while it was still
 * running does not own its row any more, and the correct outcome for its late
 * write is to match nothing — which `updateMany` expresses and `update` turns
 * into a thrown `P2025` on a path that is not an error.
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type {
  ClaimOptions,
  ClaimedOutboxRow,
  OutboxRelayStore,
} from "@/lib/outbox/relay";

/**
 * The predicate for "this row is available to be claimed".
 *
 * Three conditions, and none of them is redundant:
 *
 *   - `status: PENDING` — a processed or dead-lettered row is finished.
 *   - `availableAt <= now` — a row inside its backoff window is not due yet.
 *   - no live lease — either nobody holds it, or whoever did has expired.
 *
 * Built as a function rather than written twice because the claim is two
 * statements and the second must carry exactly the predicate the first did.
 * Two hand-written copies of this is how a claim starts overwriting live leases
 * after somebody edits one of them.
 */
function availableWhere(now: Date): Prisma.OutboxEventWhereInput {
  return {
    status: "PENDING",
    availableAt: { lte: now },
    OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
  };
}

export const prismaOutboxStore: OutboxRelayStore = {
  async claim({
    now,
    token,
    leaseMs,
    limit,
  }: ClaimOptions): Promise<ClaimedOutboxRow[]> {
    // Oldest first, so a burst of events is dispatched roughly in the order it
    // happened. Roughly is the honest word: two relays running concurrently
    // interleave, and nothing here promises a global order. `docs/outbox.md`
    // says what would be needed if an event type ever required one.
    const candidates = await prisma.outboxEvent.findMany({
      where: availableWhere(now),
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
      take: limit,
      select: { id: true },
    });

    if (candidates.length === 0) return [];

    // The same predicate again, plus the ids. A row another relay took between
    // the two statements no longer satisfies it, so this simply does not match
    // it — the claim can under-claim and cannot double-claim.
    await prisma.outboxEvent.updateMany({
      where: {
        id: { in: candidates.map((row) => row.id) },
        ...availableWhere(now),
      },
      data: {
        claimToken: token,
        claimedAt: now,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
      },
    });

    // Read back by token, which is what makes this the set actually claimed
    // rather than the set selected. The token is minted per pass, so this can
    // never pick up a row from an earlier one.
    return prisma.outboxEvent.findMany({
      where: { claimToken: token, status: "PENDING" },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
      select: { id: true, type: true, payload: true, attempts: true },
    });
  },

  async markProcessed(id: string, token: string, now: Date): Promise<void> {
    const { count } = await prisma.outboxEvent.updateMany({
      where: { id, claimToken: token },
      data: {
        status: "PROCESSED",
        processedAt: now,
        attempts: { increment: 1 },
        lastError: null,
        // The claim is released along with the row. Leaving the token behind
        // would make a processed row indistinguishable from one still held.
        claimToken: null,
        leaseExpiresAt: null,
      },
    });

    if (count === 0) {
      // Not an error: the effect happened, and the row belongs to whoever took
      // it over. Worth a line, because a relay that logs this every pass has a
      // lease shorter than its dispatches take.
      console.warn(
        `[outbox] ${id}: dispatched, but the claim had been taken over before it could be marked processed; ` +
          "it will be dispatched again.",
      );
    }
  },

  async retryLater(
    id: string,
    token: string,
    options: { availableAt: Date; error: string; now: Date },
  ): Promise<void> {
    await prisma.outboxEvent.updateMany({
      where: { id, claimToken: token },
      data: {
        status: "PENDING",
        attempts: { increment: 1 },
        availableAt: options.availableAt,
        lastError: options.error,
        claimToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
      },
    });
  },

  async markFailed(
    id: string,
    token: string,
    options: { error: string; now: Date },
  ): Promise<void> {
    await prisma.outboxEvent.updateMany({
      where: { id, claimToken: token },
      data: {
        status: "FAILED",
        attempts: { increment: 1 },
        lastError: options.error,
        processedAt: options.now,
        claimToken: null,
        leaseExpiresAt: null,
      },
    });
  },
};

/**
 * Deletes processed rows older than `before`. Returns how many went.
 *
 * A processed row is an audit trail — "this effect was performed, at this time,
 * after this many attempts" — and an audit trail nobody removes is a table that
 * grows forever. There is no scheduler in this application, so nothing calls
 * this on a timer; the relay route accepts a `sweep` flag so whatever already
 * pokes it can also ask for the sweep, and `docs/outbox.md` carries the SQL for
 * a deployment that would rather do it from cron.
 *
 * Dead letters are deliberately not swept. They are the rows that need a
 * person, and a table that quietly deletes its own unresolved failures is worse
 * than one that grows.
 */
export async function sweepProcessedEvents(before: Date): Promise<number> {
  const { count } = await prisma.outboxEvent.deleteMany({
    where: { status: "PROCESSED", processedAt: { lt: before } },
  });

  return count;
}
