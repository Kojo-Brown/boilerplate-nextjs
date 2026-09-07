import { describe, it, expect, vi } from "vitest";
import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_RELAY_ATTEMPTS,
  backoffDelayMs,
  relayOutbox,
} from "./relay";
import type { ClaimedOutboxRow, OutboxRelayStore } from "./relay";
import type { OutboxEvent } from "./events";

/**
 * An in-memory store, for the reason the idempotency protocol has one: what is
 * interesting here is the *sequence* of outcomes across attempts — backoff,
 * dead-lettering on the last one, a claim taken over mid-flight — and arranging
 * those against a real database means either sleeping or writing rows by hand
 * into states the application cannot produce. `store.test.ts` is what checks
 * the Prisma implementation honours this contract.
 */
function fakeStore(rows: ClaimedOutboxRow[]) {
  const calls = {
    claimed: [] as { token: string; limit: number; now: Date }[],
    processed: [] as { id: string; token: string }[],
    retried: [] as { id: string; availableAt: Date; error: string }[],
    failed: [] as { id: string; error: string }[],
  };

  const store: OutboxRelayStore = {
    async claim({ token, limit, now }) {
      calls.claimed.push({ token, limit, now });
      return rows.slice(0, limit);
    },
    async markProcessed(id, token) {
      calls.processed.push({ id, token });
    },
    async retryLater(id, _token, options) {
      calls.retried.push({
        id,
        availableAt: options.availableAt,
        error: options.error,
      });
    },
    async markFailed(id, _token, options) {
      calls.failed.push({ id, error: options.error });
    },
  };

  return { store, calls };
}

function row(overrides: Partial<ClaimedOutboxRow> = {}): ClaimedOutboxRow {
  return {
    id: "row-1",
    type: "post.created",
    payload: { postId: "post-1", published: true },
    attempts: 0,
    ...overrides,
  };
}

const AT = new Date("2026-03-01T12:00:00.000Z");

describe("relayOutbox", () => {
  it("dispatches a claimed event and marks it processed", async () => {
    const { store, calls } = fakeStore([row()]);
    const dispatched: OutboxEvent[] = [];

    const report = await relayOutbox({
      store,
      dispatch: (event) => {
        dispatched.push(event);
        return ["blog:post:post-1", "blog:posts"];
      },
      now: () => AT,
    });

    expect(dispatched).toEqual([
      { type: "post.created", payload: { postId: "post-1", published: true } },
    ]);
    expect(calls.processed).toEqual([
      { id: "row-1", token: expect.any(String) },
    ]);
    expect(report).toMatchObject({
      claimed: 1,
      processed: 1,
      retried: 0,
      deadLettered: 0,
      tags: ["blog:post:post-1", "blog:posts"],
      failures: [],
    });
  });

  it("carries one token through every write of a pass", async () => {
    // The token is what makes a late write safe: an attempt whose lease expired
    // while it was running must match nothing rather than conclude something
    // about a row somebody else now holds. A token minted per row, or per
    // write, would not be that.
    const { store, calls } = fakeStore([row({ id: "a" }), row({ id: "b" })]);

    await relayOutbox({ store, dispatch: () => undefined, now: () => AT });

    const tokens = new Set(calls.processed.map((call) => call.token));
    expect(tokens.size).toBe(1);
    expect([...tokens][0]).toBe(calls.claimed[0]?.token);
  });

  it("schedules a retry when a dispatch throws", async () => {
    const { store, calls } = fakeStore([row({ attempts: 2 })]);

    const report = await relayOutbox({
      store,
      dispatch: () => {
        throw new Error("cache unreachable");
      },
      now: () => AT,
      // Full jitter: the window is `[0, base · 2^(attempts-1))` and this takes
      // the top of it, so the assertion is on a value rather than a range.
      random: () => 0.999,
    });

    expect(calls.processed).toEqual([]);
    expect(calls.failed).toEqual([]);
    expect(calls.retried).toHaveLength(1);
    expect(calls.retried[0]?.error).toBe("Error: cache unreachable");
    // Third attempt: window is 1000 · 2² = 4000ms.
    expect(calls.retried[0]?.availableAt.getTime()).toBe(
      AT.getTime() + Math.floor(0.999 * 4000),
    );
    expect(report).toMatchObject({ retried: 1, processed: 0 });
    expect(report.failures[0]).toMatchObject({
      id: "row-1",
      deadLettered: false,
    });
  });

  it("dead-letters an event on its last attempt instead of retrying forever", async () => {
    const { store, calls } = fakeStore([
      row({ attempts: MAX_RELAY_ATTEMPTS - 1 }),
    ]);

    const report = await relayOutbox({
      store,
      dispatch: () => {
        throw new Error("still broken");
      },
      now: () => AT,
    });

    expect(calls.retried).toEqual([]);
    expect(calls.failed).toEqual([
      { id: "row-1", error: "Error: still broken" },
    ]);
    expect(report).toMatchObject({ deadLettered: 1, retried: 0 });
  });

  it("dead-letters an unreadable payload on its first attempt", async () => {
    // Retrying this can only produce the same result: the row's own bytes are
    // wrong, and the next attempt reads the same bytes. Spending the full
    // budget on it would also delay every row queued behind it.
    const { store, calls } = fakeStore([
      row({ payload: { postId: "post-1" }, attempts: 0 }),
    ]);
    const dispatch = vi.fn();

    const report = await relayOutbox({ store, dispatch, now: () => AT });

    expect(dispatch).not.toHaveBeenCalled();
    expect(calls.retried).toEqual([]);
    expect(calls.failed).toHaveLength(1);
    expect(calls.failed[0]?.error).toContain("Unreadable payload");
    expect(report).toMatchObject({ deadLettered: 1, claimed: 1 });
  });

  it("keeps going after one event fails", async () => {
    // Events are independent facts. One consumer failing must not strand the
    // rest of the batch, which would turn a single bad row into a stalled
    // queue.
    const { store, calls } = fakeStore([
      row({ id: "a" }),
      row({ id: "b" }),
      row({ id: "c" }),
    ]);

    let seen = 0;
    const report = await relayOutbox({
      store,
      dispatch: () => {
        seen += 1;
        if (seen === 2) throw new Error("transient");
        return [];
      },
      now: () => AT,
    });

    expect(report).toMatchObject({ claimed: 3, processed: 2, retried: 1 });
    expect(calls.retried.map((call) => call.id)).toEqual(["b"]);
  });

  it("truncates a huge error rather than putting it in a column whole", async () => {
    const { store, calls } = fakeStore([row()]);

    await relayOutbox({
      store,
      dispatch: () => {
        throw new Error("x".repeat(5_000));
      },
      now: () => AT,
    });

    expect(calls.retried[0]?.error.length).toBe(500);
    expect(calls.retried[0]?.error.endsWith("...")).toBe(true);
  });

  it("reports an empty pass without touching anything", async () => {
    const { store, calls } = fakeStore([]);
    const dispatch = vi.fn();

    const report = await relayOutbox({ store, dispatch, now: () => AT });

    expect(dispatch).not.toHaveBeenCalled();
    expect(calls.processed).toEqual([]);
    expect(report).toEqual({
      claimed: 0,
      processed: 0,
      retried: 0,
      deadLettered: 0,
      tags: [],
      failures: [],
    });
  });
});

describe("backoffDelayMs", () => {
  it("doubles the window with each attempt", () => {
    const top = (attempts: number) => backoffDelayMs(attempts, () => 0.999);

    expect(top(1)).toBe(Math.floor(0.999 * BASE_BACKOFF_MS));
    expect(top(2)).toBe(Math.floor(0.999 * BASE_BACKOFF_MS * 2));
    expect(top(3)).toBe(Math.floor(0.999 * BASE_BACKOFF_MS * 4));
  });

  it("samples from zero, not from half the window", () => {
    // Full jitter. The events that fail together usually failed for the same
    // reason, and a delay of `window/2 + jitter` still lands them in a burst on
    // a dependency that is recovering.
    expect(backoffDelayMs(5, () => 0)).toBe(0);
  });

  it("caps the window rather than the sample", () => {
    // `2 ** 40` overflows any sensible delay long before the exponent itself
    // does; capping after the multiplication is what keeps this finite.
    expect(backoffDelayMs(40, () => 0.999)).toBe(
      Math.floor(0.999 * MAX_BACKOFF_MS),
    );
    expect(Number.isFinite(backoffDelayMs(2000, () => 0.5))).toBe(true);
  });

  it("treats a first attempt and a zeroth the same", () => {
    expect(backoffDelayMs(0, () => 0.5)).toBe(backoffDelayMs(1, () => 0.5));
  });
});
