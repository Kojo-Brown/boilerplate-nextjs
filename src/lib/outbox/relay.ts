/**
 * The relay: the half of the outbox that makes a durable row worth writing.
 *
 * `writeWithOutbox` dispatches its own events inline, immediately after the
 * commit, and that is the path almost every event takes. This is what happens
 * to the ones that do not — the process died between the commit and the
 * dispatch, the cache write threw, the deployment was rolled during the
 * request. Without it the rows would accumulate as a log of effects nobody ever
 * performed, which is a more expensive way of having no outbox at all.
 *
 * ## Claiming
 *
 * A claim is `claimToken` + `leaseExpiresAt` written onto a `PENDING` row,
 * exactly as `IdempotencyKey` does it, and for the same reason: a worker that
 * is killed mid-dispatch must not hold a row forever, and a worker whose lease
 * expired while it was still running must not be able to conclude anything
 * about a row somebody else now owns. Every write below carries the token in
 * its `WHERE`.
 *
 * The claim is two statements — select candidate ids, then a conditional update
 * that carries the same predicate — and that is safe in the direction that
 * matters. Two relays can select the same ids; only one update can match, since
 * the other's `WHERE` still requires the row to be unclaimed and row locking
 * makes the second wait for the first to commit. The failure mode is
 * *under*-claiming (a relay gets fewer rows than it selected), and an unclaimed
 * `PENDING` row is simply claimed on the next tick.
 *
 * `SELECT … FOR UPDATE SKIP LOCKED` is the textbook form and would avoid those
 * wasted round trips under many concurrent relays. It is not used here because
 * it is raw SQL for a saving that only appears at a concurrency this outbox
 * does not have, and because the two-statement version cannot double-claim,
 * which is the property that actually matters. `docs/outbox.md` records what to
 * change if that stops being true.
 *
 * ## Failure handling
 *
 * Three outcomes, and the distinction between them is the point:
 *
 *   - **Dispatched.** Marked `PROCESSED`.
 *   - **Failed, and might not next time.** `availableAt` moves into the future
 *     by a full-jitter backoff and the row goes back to `PENDING`. The delay
 *     lives in the row rather than in this process, so it survives a restart.
 *   - **Failed, and will fail identically forever.** Dead-lettered as `FAILED`.
 *     A payload that does not parse is this case on its *first* attempt: no
 *     amount of retrying turns an unparseable row into a parseable one, and
 *     spending eight attempts to learn that delays every row behind it.
 *
 * Full jitter — `random(0, min(cap, base · 2^attempts))` — rather than plain
 * exponential backoff, because the events that fail together are usually the
 * ones that failed for the same reason (the cache was unreachable), and
 * retrying them all at the same instant is how a recovering dependency is
 * knocked over a second time. Jitter spreads them; taking the delay from
 * `[0, window)` rather than `[window/2, window)` spreads them furthest.
 */
import { randomUUID } from "node:crypto";
import { parseOutboxEvent } from "@/lib/outbox/events";
import type { OutboxEvent } from "@/lib/outbox/events";

/** How long a claimed row stays claimed before another worker may take it over. */
export const RELAY_LEASE_MS = 60_000;

/** How many rows one pass claims. */
export const RELAY_BATCH_SIZE = 50;

/**
 * How many times an event is attempted before it is dead-lettered.
 *
 * Eight attempts with the backoff below spans roughly twenty minutes, which
 * covers a dependency that is restarting and does not cover one that is
 * misconfigured — the distinction a retry budget is actually for.
 */
export const MAX_RELAY_ATTEMPTS = 8;

/** The first backoff window. */
export const BASE_BACKOFF_MS = 1_000;

/** The ceiling on the backoff window, so a long-dead consumer is still retried. */
export const MAX_BACKOFF_MS = 5 * 60_000;

/** A row the relay has taken, as the store hands it over. */
export interface ClaimedOutboxRow {
  id: string;
  type: string;
  payload: unknown;
  /** Attempts *before* this one. */
  attempts: number;
}

export interface ClaimOptions {
  now: Date;
  token: string;
  leaseMs: number;
  limit: number;
}

/**
 * What the relay needs from storage.
 *
 * An interface for the same reason `IdempotencyStore` is one: the interesting
 * behaviour here is the sequence of outcomes across attempts — backoff, lease
 * takeover, dead-lettering on the eighth — and arranging those against a real
 * database means either sleeping or writing rows by hand into states the
 * application cannot produce. `@/lib/outbox/store` is the Prisma
 * implementation, and its own test is what checks that it honours this
 * contract.
 */
export interface OutboxRelayStore {
  /** Takes up to `limit` due rows, marking each with this pass's token. */
  claim(options: ClaimOptions): Promise<ClaimedOutboxRow[]>;
  /** Records a dispatched event. A no-op if this pass no longer holds the row. */
  markProcessed(id: string, token: string, now: Date): Promise<void>;
  /** Returns a row to `PENDING`, claimable again at `availableAt`. */
  retryLater(
    id: string,
    token: string,
    options: { availableAt: Date; error: string; now: Date },
  ): Promise<void>;
  /** Dead-letters a row: it will not be attempted again. */
  markFailed(
    id: string,
    token: string,
    options: { error: string; now: Date },
  ): Promise<void>;
}

export interface RelayOptions {
  store: OutboxRelayStore;
  /**
   * Performs the event's effect. Throwing means "not delivered" and is what
   * schedules a retry.
   *
   * Injected rather than imported so this module holds no dependency on
   * `next/cache` — the relay's own tests would otherwise need a request context
   * to run at all, and the route handler is the only place that knows which
   * dispatch context it is in.
   *
   * Whatever it returns is treated as the cache tags dropped, and ends up in
   * the report; a consumer with nothing to report returns nothing.
   */
  dispatch: (
    event: OutboxEvent,
  ) => readonly string[] | void | Promise<readonly string[] | void>;
  now?: () => Date;
  /** Injected so a test can assert the backoff window rather than a range. */
  random?: () => number;
  limit?: number;
  leaseMs?: number;
  maxAttempts?: number;
}

export interface RelayFailure {
  id: string;
  type: string;
  /** True when the row was dead-lettered rather than scheduled for a retry. */
  deadLettered: boolean;
  error: string;
}

export interface RelayReport {
  claimed: number;
  processed: number;
  retried: number;
  deadLettered: number;
  /** The tags dropped across every dispatched event, in order. */
  tags: string[];
  failures: RelayFailure[];
}

/**
 * The backoff window for an event that has already failed `attempts` times.
 *
 * `attempts` is the count *including* the one that just failed, so the first
 * failure waits within `[0, base)`. Capped before the jitter is applied, so the
 * cap bounds the window rather than the sample.
 */
export function backoffDelayMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  // `2 ** (attempts - 1)` overflows to Infinity long before it matters, and
  // `Math.min` with a cap handles that — but only if the multiplication happens
  // in that order, which is why the cap is applied to the window and not to the
  // exponent.
  const window = Math.min(
    MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1),
  );

  return Math.floor(random() * window);
}

/**
 * Describes a thrown value for the `lastError` column.
 *
 * Truncated, because this ends up in a database column that is read by a person
 * looking at a dead letter, and a stack trace from a driver can be kilobytes.
 */
function describe(thrown: unknown): string {
  const text =
    thrown instanceof Error
      ? `${thrown.name}: ${thrown.message}`
      : String(thrown);

  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/**
 * Claims a batch of due events, dispatches each, and records what happened.
 *
 * One pass, not a loop: how often it runs is the caller's decision — a cron, a
 * worker's own interval — and a function that decided for itself would be
 * untestable and unstoppable. It returns a report rather than logging one,
 * because the caller is a route handler whose response body is the only place
 * an operator will ever see it.
 */
export async function relayOutbox(options: RelayOptions): Promise<RelayReport> {
  const {
    store,
    dispatch,
    now = () => new Date(),
    random = Math.random,
    limit = RELAY_BATCH_SIZE,
    leaseMs = RELAY_LEASE_MS,
    maxAttempts = MAX_RELAY_ATTEMPTS,
  } = options;

  // One token per pass. Every write below carries it, so a pass whose lease
  // expired mid-flight can no longer conclude anything about its rows.
  const token = randomUUID();
  const claimedAt = now();

  const rows = await store.claim({
    now: claimedAt,
    token,
    leaseMs,
    limit,
  });

  const report: RelayReport = {
    claimed: rows.length,
    processed: 0,
    retried: 0,
    deadLettered: 0,
    tags: [],
    failures: [],
  };

  for (const row of rows) {
    const parsed = parseOutboxEvent(row.type, row.payload);

    if (!parsed.success) {
      // Not a retry candidate at any attempt count. The row's own bytes are
      // wrong; the next attempt reads the same bytes.
      const error = `Unreadable payload for "${row.type}": ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")}`;

      await store.markFailed(row.id, token, { error, now: now() });
      report.deadLettered += 1;
      report.failures.push({
        id: row.id,
        type: row.type,
        deadLettered: true,
        error,
      });
      continue;
    }

    try {
      const tags = await dispatch(parsed.data);
      if (tags) report.tags.push(...tags);

      await store.markProcessed(row.id, token, now());
      report.processed += 1;
    } catch (thrown) {
      const error = describe(thrown);
      const attempts = row.attempts + 1;

      if (attempts >= maxAttempts) {
        await store.markFailed(row.id, token, { error, now: now() });
        report.deadLettered += 1;
        report.failures.push({
          id: row.id,
          type: row.type,
          deadLettered: true,
          error,
        });
        continue;
      }

      const at = now();
      await store.retryLater(row.id, token, {
        availableAt: new Date(at.getTime() + backoffDelayMs(attempts, random)),
        error,
        now: at,
      });
      report.retried += 1;
      report.failures.push({
        id: row.id,
        type: row.type,
        deadLettered: false,
        error,
      });
    }
  }

  return report;
}
