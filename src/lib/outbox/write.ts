/**
 * `writeWithOutbox` — a mutation's rows and the events describing them, in one
 * transaction.
 *
 * ## The hole this closes
 *
 * Before it, every post mutation was two steps: a Prisma write, then
 * `invalidate()`. That sequence has no failure mode anyone hits in development
 * and two in production.
 *
 *   1. The write commits and the process dies before the effect. The row is
 *      there, the blog keeps serving a list without it until the entry expires,
 *      and nothing anywhere records that an invalidation was owed. There is no
 *      retry, because there is nothing to retry *from*.
 *   2. The effect runs and the write is rolled back — or, more commonly here,
 *      the effect runs and *throws*, which is worse than either. `createPost`
 *      is idempotent, and `runIdempotent` releases the key when the handler
 *      throws so that a retry may execute. A handler that wrote a row and then
 *      failed in `invalidate()` therefore released a key whose work had already
 *      happened, and the retry wrote a second post. `@/lib/actions/idempotency`
 *      names that hole in its header and points here.
 *
 * The fix is the standard one and it is structural rather than careful: put the
 * *record of the effect* in the same transaction as the write, so it commits if
 * and only if the write does, and perform the effect from that record. An event
 * cannot then be owed for a write that rolled back, or lost for one that
 * committed.
 *
 * ## Shape
 *
 *     const post = await writeWithOutbox(async ({ tx, emit }) => {
 *       const created = await tx.post.create({ … });
 *       emit({ type: "post.created", payload: { … } });
 *       return created;
 *     });
 *
 * `emit` records; it does not dispatch. Everything emitted becomes rows in the
 * same transaction as the writes above it, and the dispatch happens after the
 * commit. That ordering is the whole mechanism, and it is why `emit` is a
 * recorder rather than a callback that does the work — an `invalidate()` called
 * inside the transaction would be announcing a write that had not committed
 * yet, and Next's cache has no way to take it back if the transaction aborts.
 *
 * ## Why `tx` and not `prisma`
 *
 * The callback is handed a transaction client and must use it. Reaching for the
 * imported `prisma` singleton inside the callback compiles, passes every test
 * that mocks the module, and silently runs that statement on a *different
 * connection*, outside the transaction — so it commits independently, is
 * invisible to the transaction's own subsequent reads, and survives a rollback
 * that was supposed to undo it. It is the defining bug of this pattern and
 * nothing at runtime reports it, which is why `scripts/assert-transactional-writes.ts`
 * fails the build on it.
 *
 * ## At-least-once, and what that asks of a consumer
 *
 * A dispatched event is marked processed in a second statement, after the
 * effect. If the process dies between those two, the relay will dispatch the
 * event again. That is inherent — the alternative is marking it processed
 * first, which turns "delivered twice" into "never delivered", and for cache
 * invalidation the first is free and the second is a stale page. So consumers
 * must be idempotent. Dropping a cache tag twice is dropping a cache tag.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { dispatchOutboxEvent } from "@/lib/outbox/dispatch";
import type { DispatchContext } from "@/lib/outbox/dispatch";
import type { OutboxEvent } from "@/lib/outbox/events";
import type { Prisma } from "@prisma/client";

/**
 * The client a transactional write is given.
 *
 * Prisma's own type for the client inside `$transaction(async (tx) => …)`: the
 * full model API minus the four things that cannot be nested — `$connect`,
 * `$disconnect`, `$on`, `$transaction`. Aliased here so call sites and the gate
 * refer to one name.
 */
export type OutboxTransaction = Prisma.TransactionClient;

/** Records an event to be written with this transaction and dispatched after it. */
export type EmitOutboxEvent = (event: OutboxEvent) => void;

export interface OutboxWriteContext {
  tx: OutboxTransaction;
  emit: EmitOutboxEvent;
}

/**
 * Thrown when `emit` is called after its transaction has closed.
 *
 * An event emitted then would never be written, and a mutation whose event is
 * silently dropped is exactly the failure the outbox exists to prevent —
 * arriving, in that case, through the mechanism meant to prevent it. The most
 * likely way to write it is a floating promise inside the callback: the
 * transaction returns, the un-awaited work continues, and its `emit` lands
 * after the commit. Throwing turns that into a test failure instead of a cache
 * that is stale on one code path.
 */
export class OutboxSealedError extends Error {
  constructor(type: string) {
    super(
      `Cannot emit "${type}": the transaction has already closed. ` +
        "Every emit must happen inside the writeWithOutbox callback, before it resolves — " +
        "an un-awaited promise inside the callback is the usual cause.",
    );
    this.name = "OutboxSealedError";
  }
}

export interface WriteWithOutboxOptions {
  /**
   * Where the inline dispatch is running. Defaults to `"server-action"`,
   * because that is what every caller is today and a wrong default here throws
   * on the first call rather than failing quietly. See `@/lib/outbox/dispatch`.
   */
  context?: DispatchContext;
  /**
   * How long the interactive transaction may run before Prisma aborts it.
   *
   * Prisma's default is 5 seconds, and it is worth being explicit rather than
   * inheriting: a transaction holds a connection and row locks for its whole
   * duration, so the ceiling is a statement about how long a mutation may block
   * other writers, not about how slow a query is allowed to be.
   */
  timeoutMs?: number;
  /** How long to wait for a connection from the pool before giving up. */
  maxWaitMs?: number;
}

/** Prisma's own defaults, named so the reason for each is written down. */
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_WAIT_MS = 2_000;

/**
 * Runs `write` in an interactive transaction, writes everything it emitted as
 * outbox rows in that same transaction, and dispatches those events once it has
 * committed.
 *
 * Returns whatever the callback returned. A callback that emits nothing is
 * fine and writes no rows — a mutation that turned out to be a no-op (a
 * conditional update that matched nothing) owes no effects, and reporting one
 * would be reporting a change that did not happen.
 */
export async function writeWithOutbox<T>(
  write: (context: OutboxWriteContext) => Promise<T>,
  options: WriteWithOutboxOptions = {},
): Promise<T> {
  const {
    context = "server-action",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
  } = options;

  const committed = await prisma.$transaction(
    async (tx) => {
      const events: OutboxEvent[] = [];
      let sealed = false;

      const emit: EmitOutboxEvent = (event) => {
        if (sealed) throw new OutboxSealedError(event.type);
        events.push(event);
      };

      const result = await write({ tx, emit });

      // Sealed before the rows are written, not after: from here on the set of
      // events is fixed, and an `emit` arriving late must fail loudly rather
      // than append to a list nobody will read again.
      sealed = true;

      if (events.length === 0) return { result, rows: [] as OutboxRow[] };

      // Ids are minted here rather than left to `@default(cuid())` so that the
      // insert and the dispatch below agree on which row is which without a
      // `RETURNING` round trip — and so a failed dispatch names a row an
      // operator can find.
      const rows: OutboxRow[] = events.map((event) => ({
        id: randomUUID(),
        event,
      }));

      await tx.outboxEvent.createMany({
        data: rows.map(({ id, event }) => ({
          id,
          type: event.type,
          // A structural clone, so a payload holding a live object reference
          // cannot be mutated between the insert and the dispatch.
          payload: JSON.parse(JSON.stringify(event.payload)) as object,
        })),
      });

      return { result, rows };
    },
    { timeout: timeoutMs, maxWait: maxWaitMs },
  );

  await dispatchCommitted(committed.rows, context);

  return committed.result;
}

interface OutboxRow {
  id: string;
  event: OutboxEvent;
}

/**
 * Dispatches the events of a committed transaction and marks them processed.
 *
 * Deliberately does not throw. The write is committed by the time this runs, so
 * a failure here is not a failed mutation — reporting one to the caller would
 * tell them their post was not created when it was, which is the single most
 * reliable way to produce the duplicate submission the idempotency layer exists
 * to prevent. What it does instead is leave the row `PENDING`, which is the
 * outbox working: the relay picks it up and the effect happens late rather than
 * never.
 *
 * Marking is one statement for the whole batch, and it carries no claim token
 * because these rows have never been claimed — they were inserted moments ago
 * by this transaction and no relay has seen them. `status: "PENDING"` in the
 * `WHERE` is what keeps that honest: if a relay *has* somehow taken one (a very
 * slow dispatch, a lease-free window), it matches nothing rather than
 * overwriting whatever the relay concluded.
 */
async function dispatchCommitted(
  rows: readonly OutboxRow[],
  context: DispatchContext,
): Promise<void> {
  if (rows.length === 0) return;

  const dispatched: string[] = [];

  for (const { id, event } of rows) {
    try {
      dispatchOutboxEvent(event, context);
      dispatched.push(id);
    } catch (thrown) {
      // One event failing does not stop the others: they are independent facts,
      // and the relay will retry this one on its own.
      console.error(
        `[outbox] ${event.type} (${id}) could not be dispatched inline; leaving it for the relay:`,
        thrown,
      );
    }
  }

  if (dispatched.length === 0) return;

  try {
    await prisma.outboxEvent.updateMany({
      where: { id: { in: dispatched }, status: "PENDING" },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
  } catch (thrown) {
    // The effect has happened; only the receipt failed. The row stays PENDING
    // and the relay will dispatch it a second time, which is why consumers must
    // be idempotent — see this module's header.
    console.error(
      "[outbox] dispatched inline but could not mark the rows processed; " +
        "the relay will dispatch them again:",
      thrown,
    );
  }
}
