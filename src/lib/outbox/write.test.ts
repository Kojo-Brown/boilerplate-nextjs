import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The transaction client and the singleton are two different mocks here, on
 * purpose.
 *
 * Everywhere else in this suite `@/lib/prisma` is mocked as one object and
 * `$transaction` hands the callback that same object back, which is convenient
 * and hides the one bug this module is shaped against: a callback that writes
 * through the imported singleton instead of its transaction client. Keeping
 * them distinct is what lets the test below assert that the writes landed on
 * the transaction — the property `scripts/assert-transactional-writes.ts`
 * enforces statically.
 */
const tx = {
  post: { create: vi.fn(), update: vi.fn() },
  outboxEvent: { createMany: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
    post: { create: vi.fn(), update: vi.fn() },
    outboxEvent: { createMany: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock("@/lib/outbox/dispatch", () => ({
  dispatchOutboxEvent: vi.fn(() => ["blog:posts"]),
}));

import { prisma } from "@/lib/prisma";
import { dispatchOutboxEvent } from "@/lib/outbox/dispatch";
import { OutboxSealedError, writeWithOutbox } from "./write";
import type { OutboxTransaction } from "./write";

/**
 * `$transaction` is overloaded — a batch of promises, or an interactive
 * callback — and `vi.mocked` binds to the first of those. Narrowing it to the
 * interactive form is what makes the assertions below readable, and is the same
 * move `posts.test.ts` makes for NextAuth's overloaded `auth`.
 */
type InteractiveTransaction = (
  callback: (client: unknown) => Promise<unknown>,
  options?: { timeout: number; maxWait: number },
) => Promise<unknown>;

const mockTransaction = vi.mocked(
  prisma.$transaction as unknown as InteractiveTransaction,
);
const mockUpdateMany = vi.mocked(prisma.outboxEvent.updateMany);
const mockDispatch = vi.mocked(dispatchOutboxEvent);

/** Runs the callback against the fake transaction client, as Prisma would. */
function runTransaction() {
  mockTransaction.mockImplementation(async (callback) => callback(tx));
}

/** Aborts instead, as Prisma does when the callback throws. */
function failingTransaction(error: unknown) {
  mockTransaction.mockImplementation(async (callback) => {
    // Prisma runs the callback and rolls back if it throws; the write to
    // `outboxEvent` inside it never reaches the database.
    await callback(tx);
    throw error;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tx.post.create.mockResolvedValue({ id: "post-1", published: true });
  tx.outboxEvent.createMany.mockResolvedValue({ count: 1 });
  mockUpdateMany.mockResolvedValue({ count: 1 } as never);
  mockDispatch.mockReturnValue(["blog:posts"]);
  runTransaction();
});

describe("writeWithOutbox", () => {
  it("writes the rows and the events in one transaction", async () => {
    const result = await writeWithOutbox(async ({ tx: client, emit }) => {
      const post = await client.post.create({
        data: { title: "Hello", authorId: "user-1" },
      });
      emit({
        type: "post.created",
        payload: { postId: "post-1", published: true },
      });
      return post;
    });

    expect(result).toEqual({ id: "post-1", published: true });

    // The insert went to the transaction client, not the singleton. This is the
    // assertion the shared-object mock everywhere else cannot make.
    expect(tx.post.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.post.create)).not.toHaveBeenCalled();

    expect(tx.outboxEvent.createMany).toHaveBeenCalledTimes(1);
    const [call] = tx.outboxEvent.createMany.mock.calls;
    expect(call?.[0]).toMatchObject({
      data: [
        {
          type: "post.created",
          payload: { postId: "post-1", published: true },
        },
      ],
    });
  });

  it("dispatches after the transaction, never inside it", async () => {
    // The ordering is the mechanism. An `invalidate()` from inside the
    // transaction would announce a write that has not committed, and Next's
    // cache has no way to take that back if the transaction then aborts.
    const order: string[] = [];

    mockTransaction.mockImplementation(async (callback) => {
      const value = await callback(tx);
      order.push("commit");
      return value;
    });
    mockDispatch.mockImplementation(() => {
      order.push("dispatch");
      return [];
    });

    await writeWithOutbox(async ({ emit }) => {
      order.push("write");
      emit({
        type: "post.created",
        payload: { postId: "post-1", published: false },
      });
    });

    expect(order).toEqual(["write", "commit", "dispatch"]);
  });

  it("marks dispatched rows processed", async () => {
    await writeWithOutbox(async ({ emit }) => {
      emit({
        type: "post.deleted",
        payload: { postId: "post-1", wasPublished: true },
      });
    });

    const [call] = mockUpdateMany.mock.calls;
    expect(call?.[0]).toMatchObject({
      where: { status: "PENDING" },
      data: { status: "PROCESSED", attempts: { increment: 1 } },
    });
    // The ids in the `where` are the ones just inserted, so the mark cannot
    // touch a row this transaction did not write.
    const inserted = tx.outboxEvent.createMany.mock.calls[0]?.[0] as {
      data: { id: string }[];
    };
    expect(call?.[0].where?.id).toEqual({
      in: inserted.data.map((row) => row.id),
    });
  });

  it("leaves the row pending when the inline dispatch throws", async () => {
    // The write is committed by now, so failing the action would tell the
    // caller their post was not created when it was — which is the reliable way
    // to produce a duplicate submission. The relay is what makes carrying on
    // safe.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockDispatch.mockImplementation(() => {
      throw new Error("updateTag exploded");
    });

    const result = await writeWithOutbox(async ({ emit }) => {
      emit({
        type: "post.created",
        payload: { postId: "post-1", published: true },
      });
      return "returned anyway";
    });

    expect(result).toBe("returned anyway");
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("still returns the value when the receipt cannot be written", async () => {
    // The effect happened; only the mark failed. The row stays PENDING and the
    // relay dispatches it a second time, which is why consumers must be
    // idempotent.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockUpdateMany.mockRejectedValue(new Error("connection lost"));

    await expect(
      writeWithOutbox(async ({ emit }) => {
        emit({
          type: "post.created",
          payload: { postId: "post-1", published: true },
        });
        return "ok";
      }),
    ).resolves.toBe("ok");

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("writes nothing and dispatches nothing when the callback emits nothing", async () => {
    // A conditional update that matched no rows owes no effects, and an event
    // for it would be an announcement of a change that did not happen.
    const result = await writeWithOutbox(async () => ({ status: "stale" }));

    expect(result).toEqual({ status: "stale" });
    expect(tx.outboxEvent.createMany).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("does not dispatch when the transaction aborts", async () => {
    failingTransaction(new Error("rolled back"));

    await expect(
      writeWithOutbox(async ({ emit }) => {
        emit({
          type: "post.created",
          payload: { postId: "post-1", published: true },
        });
      }),
    ).rejects.toThrow("rolled back");

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses an emit that arrives after the transaction closed", async () => {
    // The shape a floating promise inside the callback produces: the
    // transaction resolves, the un-awaited work carries on, and its event would
    // be silently dropped — the outbox failing in exactly the way it exists to
    // prevent.
    let escaped: ((event: never) => void) | undefined;

    await writeWithOutbox(async ({ emit }) => {
      escaped = emit as (event: never) => void;
    });

    expect(() =>
      (escaped as unknown as (event: unknown) => void)({
        type: "post.created",
        payload: { postId: "post-1", published: true },
      }),
    ).toThrow(OutboxSealedError);
  });

  it("gives Prisma an explicit timeout rather than inheriting one", async () => {
    await writeWithOutbox(async () => undefined, {
      timeoutMs: 1234,
      maxWaitMs: 567,
    });

    expect(mockTransaction.mock.calls[0]?.[1]).toEqual({
      timeout: 1234,
      maxWait: 567,
    });
  });

  it("passes the dispatch context through", async () => {
    await writeWithOutbox(
      async ({ emit }) => {
        emit({
          type: "post.created",
          payload: { postId: "post-1", published: true },
        });
      },
      { context: "route-handler" },
    );

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.anything(),
      "route-handler",
    );
  });

  it("hands the callback a client that is not the singleton", async () => {
    // Guards the guard: if this ever passes with `client === prisma`, the test
    // above proves nothing.
    let client: OutboxTransaction | undefined;
    await writeWithOutbox(async ({ tx: given }) => {
      client = given;
    });

    expect(client).toBe(tx);
    expect(client).not.toBe(prisma);
  });
});
