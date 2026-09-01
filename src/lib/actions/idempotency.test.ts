import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionError } from "@/lib/actions/result";
import {
  canonicalise,
  fingerprint,
  runIdempotent,
  toStoredJson,
  UnfingerprintableValueError,
  IN_FLIGHT_MESSAGE,
  KEY_CONFLICT_MESSAGE,
  UNREPLAYABLE_MESSAGE,
} from "./idempotency";
import type {
  ClaimOutcome,
  ClaimRequest,
  IdempotencyRecord,
  IdempotencyStore,
} from "./idempotency";

const RECORD: IdempotencyRecord = {
  scope: "user:user-1",
  action: "createPost",
  key: "key-0000-0000-0001",
};

/**
 * An in-memory `IdempotencyStore` with the semantics the Prisma one implements.
 *
 * Worth having as well as the stub stores below, because the properties that
 * matter most about this protocol are about *interleavings* — two attempts
 * arriving at once, one attempt outliving its lease — and arranging those
 * against a real Postgres means real concurrent transactions, which is an
 * order of magnitude more machinery than the thing being tested.
 *
 * Two details make it a faithful model rather than a convenient one. Claims are
 * decided without an `await`, so the check and the write cannot interleave —
 * which is what the unique index buys in Postgres. And results go through
 * `toStoredJson` in `runIdempotent` before they arrive here, so a stored `Date`
 * is a string by the time it comes back, exactly as it is out of a `Json`
 * column.
 */
class MemoryStore implements IdempotencyStore {
  readonly rows = new Map<
    string,
    {
      fingerprint: string;
      claimToken: string;
      status: "IN_PROGRESS" | "COMPLETED";
      result: unknown;
      expiresAt: Date;
    }
  >();

  private id(record: IdempotencyRecord): string {
    return `${record.scope}|${record.action}|${record.key}`;
  }

  claim(request: ClaimRequest): Promise<ClaimOutcome> {
    const id = this.id(request);
    const existing = this.rows.get(id);

    if (!existing || existing.expiresAt.getTime() < request.now.getTime()) {
      this.rows.set(id, {
        fingerprint: request.fingerprint,
        claimToken: request.token,
        status: "IN_PROGRESS",
        result: null,
        expiresAt: new Date(request.now.getTime() + request.leaseMs),
      });
      return Promise.resolve({ kind: "claimed" });
    }

    if (existing.fingerprint !== request.fingerprint) {
      return Promise.resolve({ kind: "conflict" });
    }

    if (existing.status === "COMPLETED") {
      return Promise.resolve({ kind: "replay", result: existing.result });
    }

    return Promise.resolve({ kind: "in_flight" });
  }

  complete(
    record: IdempotencyRecord,
    options: {
      token: string;
      result: unknown;
      now: Date;
      retentionMs: number;
    },
  ): Promise<void> {
    const row = this.rows.get(this.id(record));
    if (!row || row.claimToken !== options.token) return Promise.resolve();

    row.status = "COMPLETED";
    row.result = options.result;
    row.expiresAt = new Date(options.now.getTime() + options.retentionMs);
    return Promise.resolve();
  }

  release(record: IdempotencyRecord, token: string): Promise<void> {
    const id = this.id(record);
    const row = this.rows.get(id);
    if (row && row.claimToken === token && row.status === "IN_PROGRESS") {
      this.rows.delete(id);
    }
    return Promise.resolve();
  }
}

/** A store that answers every claim the same way and records what it was told. */
function stubStore(outcome: ClaimOutcome): IdempotencyStore & {
  complete: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    claim: vi.fn(() => Promise.resolve(outcome)),
    complete: vi.fn(() => Promise.resolve()),
    release: vi.fn(() => Promise.resolve()),
  } as unknown as IdempotencyStore & {
    complete: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}

/** `runIdempotent` with the identity revival, for results that are plain JSON. */
function run<T>(
  store: IdempotencyStore,
  handler: () => Promise<T> | T,
  overrides: Partial<Parameters<typeof runIdempotent<T>>[0]> = {},
): Promise<T> {
  return runIdempotent<T>({
    store,
    record: RECORD,
    fingerprint: "fp-a",
    revive: (stored) => stored as T,
    run: handler,
    ...overrides,
  });
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("canonicalise", () => {
  it("is insensitive to property order", () => {
    expect(canonicalise({ a: 1, b: 2 })).toBe(canonicalise({ b: 2, a: 1 }));
  });

  it("distinguishes values JSON.stringify collapses", () => {
    // `JSON.stringify` turns the first into `[1,null]` and the second into
    // `[1,null]` as well, so a fingerprint built on it cannot tell a missing
    // element from an explicit null.
    expect(canonicalise([1, undefined])).not.toBe(canonicalise([1, null]));
  });

  it("ignores properties whose value is undefined", () => {
    // React drops undefined properties when serialising a Server Action
    // argument, so the two spellings are the same request arriving twice.
    expect(canonicalise({ a: 1, b: undefined })).toBe(canonicalise({ a: 1 }));
  });

  it("does not collapse a nested object into its parent's key order", () => {
    expect(canonicalise({ a: { x: 1, y: 2 } })).toBe(
      canonicalise({ a: { y: 2, x: 1 } }),
    );
    expect(canonicalise({ a: { x: 1 } })).not.toBe(
      canonicalise({ a: { x: 2 } }),
    );
  });

  it("treats -0 and 0 as the same value", () => {
    expect(canonicalise(-0)).toBe(canonicalise(0));
  });

  it("keeps NaN and Infinity distinguishable", () => {
    expect(canonicalise(Number.NaN)).not.toBe(canonicalise(null));
    expect(canonicalise(Number.POSITIVE_INFINITY)).not.toBe(
      canonicalise(Number.NEGATIVE_INFINITY),
    );
  });

  it("encodes dates by their instant", () => {
    expect(canonicalise(new Date("2024-01-01T00:00:00.000Z"))).toBe(
      canonicalise(new Date(Date.UTC(2024, 0, 1))),
    );
  });

  it("does not let a string impersonate a number or a date", () => {
    expect(canonicalise("1")).not.toBe(canonicalise(1));
    expect(canonicalise("2024-01-01T00:00:00.000Z")).not.toBe(
      canonicalise(new Date("2024-01-01T00:00:00.000Z")),
    );
  });

  it("refuses a value with no canonical form", () => {
    // A `Map` stringifies to `{}` — every Map in the world would share one
    // fingerprint, which is the silent-collision case this throw prevents.
    expect(() => canonicalise(new Map([["a", 1]]))).toThrow(
      UnfingerprintableValueError,
    );
    expect(() => canonicalise(() => undefined)).toThrow(
      UnfingerprintableValueError,
    );
  });
});

describe("fingerprint", () => {
  it("is stable across property order", () => {
    expect(fingerprint({ title: "a", content: "b" })).toBe(
      fingerprint({ content: "b", title: "a" }),
    );
  });

  it("changes when any value changes", () => {
    expect(fingerprint({ title: "a" })).not.toBe(fingerprint({ title: "b" }));
  });
});

describe("toStoredJson", () => {
  it("loses the types a Json column loses", () => {
    // Not an assertion about JSON so much as a statement of why the output
    // schema exists: this is what a replayed result looks like before it is
    // revived, and a caller expecting a Date would find a string.
    expect(toStoredJson({ at: new Date("2024-01-01T00:00:00.000Z") })).toEqual({
      at: "2024-01-01T00:00:00.000Z",
    });
  });

  it("stores a handler that returned nothing as null", () => {
    expect(toStoredJson(undefined)).toBeNull();
  });
});

describe("runIdempotent", () => {
  it("runs the handler when the key is free", async () => {
    const store = new MemoryStore();
    const handler = vi.fn(() => Promise.resolve({ id: "post-1" }));

    await expect(run(store, handler)).resolves.toEqual({ id: "post-1" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("replays the stored result instead of running the handler again", async () => {
    const store = new MemoryStore();
    const handler = vi.fn(() => Promise.resolve({ id: "post-1" }));

    const first = await run(store, handler);
    const second = await run(store, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("runs the handler exactly once for two concurrent attempts", async () => {
    const store = new MemoryStore();
    let running = 0;
    const handler = vi.fn(async () => {
      running += 1;
      await Promise.resolve();
      return { concurrent: running };
    });

    const [first, second] = await Promise.allSettled([
      run(store, handler),
      run(store, handler),
    ]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(first.status).toBe("fulfilled");
    // The loser is refused rather than made to wait. Waiting would hold a
    // server connection open for the duration of another request, which is how
    // a double-submit turns into an outage.
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.reason).toBeInstanceOf(ActionError);
      expect((second.reason as ActionError).message).toBe(IN_FLIGHT_MESSAGE);
    }
  });

  it("refuses a key reused for a different payload", async () => {
    const store = new MemoryStore();
    const handler = vi.fn(() => Promise.resolve({ id: "post-1" }));

    await run(store, handler);

    await expect(run(store, handler, { fingerprint: "fp-b" })).rejects.toThrow(
      KEY_CONFLICT_MESSAGE,
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("releases the key when the handler throws, so a retry can execute", async () => {
    const store = new MemoryStore();
    const handler = vi
      .fn<() => Promise<{ id: string }>>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce({ id: "post-1" });

    await expect(run(store, handler)).rejects.toThrow("connection reset");
    await expect(run(store, handler)).resolves.toEqual({ id: "post-1" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("reports the handler's own error, not the store's, when releasing fails", async () => {
    const store = stubStore({ kind: "claimed" });
    store.release.mockRejectedValue(new Error("store is down"));

    await expect(
      run(store, () => Promise.reject(new Error("the real problem"))),
    ).rejects.toThrow("the real problem");
  });

  it("returns the handler's value even when the result cannot be recorded", async () => {
    // The write already happened. Failing here would tell the caller their post
    // was not created when it was, which is the one answer guaranteed to
    // produce the duplicate submission.
    const store = stubStore({ kind: "claimed" });
    store.complete.mockRejectedValue(new Error("store is down"));

    await expect(run(store, () => ({ id: "post-1" }))).resolves.toEqual({
      id: "post-1",
    });
  });

  it("refuses rather than re-running when a stored result cannot be revived", async () => {
    const store = stubStore({ kind: "replay", result: { shape: "old" } });
    const handler = vi.fn(() => Promise.resolve({ id: "post-1" }));

    await expect(
      runIdempotent({
        store,
        record: RECORD,
        fingerprint: "fp-a",
        revive: () => {
          throw new Error("no longer parses");
        },
        run: handler,
      }),
    ).rejects.toThrow(UNREPLAYABLE_MESSAGE);
    expect(handler).not.toHaveBeenCalled();
  });

  it("revives a replayed result into the same shape the handler returned", async () => {
    // The trap this whole mechanism has to survive: `createdAt` goes into the
    // store as a Date and comes back as a string, and a caller reaching for a
    // Date method on the replay would fail on the second submission only.
    const store = new MemoryStore();
    const created = { id: "post-1", createdAt: new Date("2024-01-01") };
    const revive = (stored: unknown): typeof created => {
      const raw = stored as { id: string; createdAt: string };
      return { id: raw.id, createdAt: new Date(raw.createdAt) };
    };

    const fresh = await runIdempotent({
      store,
      record: RECORD,
      fingerprint: "fp-a",
      revive,
      run: () => created,
    });
    const replayed = await runIdempotent({
      store,
      record: RECORD,
      fingerprint: "fp-a",
      revive,
      run: () => created,
    });

    expect(replayed).toEqual(fresh);
    expect(replayed.createdAt).toBeInstanceOf(Date);
  });

  it("lets a later attempt through once the completed row's retention expires", async () => {
    const store = new MemoryStore();
    const handler = vi.fn(() => Promise.resolve({ id: "post-1" }));
    let clock = new Date("2024-01-01T00:00:00.000Z");

    await run(store, handler, { now: () => clock, retentionMs: 1_000 });
    clock = new Date("2024-01-01T00:00:02.000Z");
    await run(store, handler, { now: () => clock, retentionMs: 1_000 });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("lets another attempt take over an abandoned in-flight claim", async () => {
    // A process that died between claiming the key and recording the result
    // would otherwise hold it forever, and the caller could never retry.
    const store = new MemoryStore();
    let clock = new Date("2024-01-01T00:00:00.000Z");

    await store.claim({
      ...RECORD,
      fingerprint: "fp-a",
      token: "abandoned-attempt",
      now: clock,
      leaseMs: 1_000,
    });

    clock = new Date("2024-01-01T00:00:02.000Z");
    const handler = vi.fn(() => Promise.resolve({ id: "post-1" }));

    await expect(
      run(store, handler, { now: () => clock, leaseMs: 1_000 }),
    ).resolves.toEqual({ id: "post-1" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores a result written by an attempt that lost its claim", async () => {
    // The stalled attempt from the test above, waking up after a takeover: its
    // token no longer matches, so its result must not land on the live row.
    const store = new MemoryStore();
    const now = new Date("2024-01-01T00:00:00.000Z");

    await store.claim({
      ...RECORD,
      fingerprint: "fp-a",
      token: "live-attempt",
      now,
      leaseMs: 60_000,
    });

    await store.complete(RECORD, {
      token: "stale-attempt",
      result: { id: "from-the-stalled-attempt" },
      now,
      retentionMs: 60_000,
    });

    const row = store.rows.get(
      `${RECORD.scope}|${RECORD.action}|${RECORD.key}`,
    );
    expect(row?.status).toBe("IN_PROGRESS");
    expect(row?.result).toBeNull();
  });

  it("keeps one user's key out of another user's scope", async () => {
    const store = new MemoryStore();
    const handler = vi.fn(() => Promise.resolve({ id: "post-1" }));

    await run(store, handler);
    await run(store, handler, {
      record: { ...RECORD, scope: "user:user-2" },
    });

    // Same key string, different principal, so it is a different key. Sharing
    // one key space would answer the second user with the first one's post.
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("keeps one action's key out of another action's space", async () => {
    const store = new MemoryStore();
    const handler = vi.fn(() => Promise.resolve({ id: "post-1" }));

    await run(store, handler);
    await run(store, handler, {
      record: { ...RECORD, action: "updatePost" },
    });

    expect(handler).toHaveBeenCalledTimes(2);
  });
});
