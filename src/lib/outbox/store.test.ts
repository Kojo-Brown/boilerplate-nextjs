import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    outboxEvent: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import { prismaOutboxStore, sweepProcessedEvents } from "./store";

const findMany = vi.mocked(prisma.outboxEvent.findMany);
const updateMany = vi.mocked(prisma.outboxEvent.updateMany);
const deleteMany = vi.mocked(prisma.outboxEvent.deleteMany);

const NOW = new Date("2026-03-01T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  updateMany.mockResolvedValue({ count: 1 });
  deleteMany.mockResolvedValue({ count: 0 });
});

describe("claim", () => {
  it("selects, takes with a token, and reads back only what it took", async () => {
    findMany
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }] as never)
      .mockResolvedValueOnce([
        { id: "a", type: "post.created", payload: {}, attempts: 0 },
      ] as never);
    updateMany.mockResolvedValue({ count: 1 });

    const claimed = await prismaOutboxStore.claim({
      now: NOW,
      token: "token-1",
      leaseMs: 60_000,
      limit: 10,
    });

    // Two rows were candidates and one was actually taken — the other went to a
    // concurrent relay between the two statements. Reading back by token rather
    // than by the selected ids is what makes this pass return one row instead
    // of dispatching a row it does not hold.
    expect(claimed.map((row) => row.id)).toEqual(["a"]);

    const take = updateMany.mock.calls[0]?.[0];
    expect(take?.where).toMatchObject({
      id: { in: ["a", "b"] },
      status: "PENDING",
      availableAt: { lte: NOW },
    });
    // The availability predicate is repeated in the update, so a row somebody
    // else took between the two statements no longer matches it.
    expect(take?.where?.OR).toEqual([
      { leaseExpiresAt: null },
      { leaseExpiresAt: { lt: NOW } },
    ]);
    expect(take?.data).toMatchObject({
      claimToken: "token-1",
      claimedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    });
  });

  it("treats an expired lease as available", async () => {
    findMany.mockResolvedValue([] as never);

    await prismaOutboxStore.claim({
      now: NOW,
      token: "token-1",
      leaseMs: 60_000,
      limit: 5,
    });

    const [select] = findMany.mock.calls;
    expect(select?.[0]?.where?.OR).toEqual([
      { leaseExpiresAt: null },
      { leaseExpiresAt: { lt: NOW } },
    ]);
    // A worker killed mid-dispatch must not hold a row forever; the lease is
    // the only thing that releases it.
    expect(select?.[0]?.take).toBe(5);
  });

  it("does not write anything when nothing is due", async () => {
    findMany.mockResolvedValue([] as never);

    expect(
      await prismaOutboxStore.claim({
        now: NOW,
        token: "token-1",
        leaseMs: 60_000,
        limit: 5,
      }),
    ).toEqual([]);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("the writes that end an attempt", () => {
  it("marks processed only while this pass still holds the row", async () => {
    await prismaOutboxStore.markProcessed("row-1", "token-1", NOW);

    const [call] = updateMany.mock.calls;
    expect(call?.[0].where).toEqual({ id: "row-1", claimToken: "token-1" });
    expect(call?.[0].data).toMatchObject({
      status: "PROCESSED",
      processedAt: NOW,
      attempts: { increment: 1 },
      claimToken: null,
      leaseExpiresAt: null,
    });
  });

  it("warns rather than throwing when the claim was taken over", async () => {
    // Not an error: the effect happened, and the row belongs to whoever took it
    // over. Throwing here would turn a benign race into a failed relay pass.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    updateMany.mockResolvedValue({ count: 0 });

    await expect(
      prismaOutboxStore.markProcessed("row-1", "stale-token", NOW),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns a row to PENDING with its backoff and releases the claim", async () => {
    const availableAt = new Date(NOW.getTime() + 4_000);

    await prismaOutboxStore.retryLater("row-1", "token-1", {
      availableAt,
      error: "Error: nope",
      now: NOW,
    });

    const [call] = updateMany.mock.calls;
    expect(call?.[0].where).toEqual({ id: "row-1", claimToken: "token-1" });
    expect(call?.[0].data).toMatchObject({
      status: "PENDING",
      availableAt,
      attempts: { increment: 1 },
      lastError: "Error: nope",
      claimToken: null,
      leaseExpiresAt: null,
    });
  });

  it("dead-letters with the reason attached", async () => {
    await prismaOutboxStore.markFailed("row-1", "token-1", {
      error: "Error: gave up",
      now: NOW,
    });

    const [call] = updateMany.mock.calls;
    expect(call?.[0].where).toEqual({ id: "row-1", claimToken: "token-1" });
    expect(call?.[0].data).toMatchObject({
      status: "FAILED",
      lastError: "Error: gave up",
    });
  });

  it("carries the token in every write that ends an attempt", async () => {
    // The property the whole lease depends on: an attempt whose lease expired
    // while it was running must match nothing rather than overwrite a row a
    // later pass now owns.
    await prismaOutboxStore.markProcessed("row-1", "t", NOW);
    await prismaOutboxStore.retryLater("row-1", "t", {
      availableAt: NOW,
      error: "e",
      now: NOW,
    });
    await prismaOutboxStore.markFailed("row-1", "t", { error: "e", now: NOW });

    for (const call of updateMany.mock.calls) {
      expect(call[0].where).toMatchObject({ claimToken: "t" });
    }
  });
});

describe("sweepProcessedEvents", () => {
  it("deletes processed rows past the cutoff and nothing else", async () => {
    deleteMany.mockResolvedValue({ count: 3 });

    expect(await sweepProcessedEvents(NOW)).toBe(3);
    expect(deleteMany.mock.calls[0]?.[0]?.where).toEqual({
      status: "PROCESSED",
      processedAt: { lt: NOW },
    });
  });

  it("leaves dead letters alone", async () => {
    await sweepProcessedEvents(NOW);

    // A table that quietly deletes its own unresolved failures is worse than
    // one that grows: a dead letter is the row that needs a person.
    expect(deleteMany.mock.calls[0]?.[0]?.where?.status).toBe("PROCESSED");
  });
});
