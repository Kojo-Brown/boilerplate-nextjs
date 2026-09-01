import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    idempotencyKey: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isUniqueViolation, prismaIdempotencyStore } from "./idempotency-store";
import type { ClaimRequest } from "./idempotency";

const NOW = new Date("2024-01-01T00:00:00.000Z");

const RECORD = {
  scope: "user:user-1",
  action: "createPost",
  key: "key-0000-0000-0001",
};

const CLAIM: ClaimRequest = {
  ...RECORD,
  fingerprint: "fp-a",
  token: "attempt-1",
  now: NOW,
  leaseMs: 60_000,
};

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "7.9.1",
  });
}

const mockCreate = vi.mocked(prisma.idempotencyKey.create);
const mockUpdateMany = vi.mocked(prisma.idempotencyKey.updateMany);
const mockFindUnique = vi.mocked(prisma.idempotencyKey.findUnique);
const mockDeleteMany = vi.mocked(prisma.idempotencyKey.deleteMany);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockCreate.mockResolvedValue({} as never);
  mockUpdateMany.mockResolvedValue({ count: 0 } as never);
  mockFindUnique.mockResolvedValue(null as never);
  mockDeleteMany.mockResolvedValue({ count: 0 } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isUniqueViolation", () => {
  it("recognises P2002 and nothing else", () => {
    expect(isUniqueViolation(uniqueViolation())).toBe(true);
    expect(
      isUniqueViolation(
        new Prisma.PrismaClientKnownRequestError("Record not found", {
          code: "P2025",
          clientVersion: "7.9.1",
        }),
      ),
    ).toBe(false);
    expect(isUniqueViolation(new Error("Unique constraint failed"))).toBe(
      false,
    );
  });
});

describe("claim", () => {
  it("takes the key with a single insert when it is free", async () => {
    await expect(prismaIdempotencyStore.claim(CLAIM)).resolves.toEqual({
      kind: "claimed",
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        scope: RECORD.scope,
        action: RECORD.action,
        key: RECORD.key,
        fingerprint: "fp-a",
        claimToken: "attempt-1",
        status: "IN_PROGRESS",
        expiresAt: new Date("2024-01-01T00:01:00.000Z"),
      },
    });
    // Nothing else runs on the happy path: the insert is the whole decision.
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("reports an unexpired in-flight row as in flight", async () => {
    mockCreate.mockRejectedValue(uniqueViolation());
    mockFindUnique.mockResolvedValue({
      fingerprint: "fp-a",
      status: "IN_PROGRESS",
      result: null,
    } as never);

    await expect(prismaIdempotencyStore.claim(CLAIM)).resolves.toEqual({
      kind: "in_flight",
    });
  });

  it("replays a completed row with a matching fingerprint", async () => {
    mockCreate.mockRejectedValue(uniqueViolation());
    mockFindUnique.mockResolvedValue({
      fingerprint: "fp-a",
      status: "COMPLETED",
      result: { id: "post-1" },
    } as never);

    await expect(prismaIdempotencyStore.claim(CLAIM)).resolves.toEqual({
      kind: "replay",
      result: { id: "post-1" },
    });
  });

  it("reports a conflict for a different payload, in flight or not", async () => {
    mockCreate.mockRejectedValue(uniqueViolation());

    for (const status of ["IN_PROGRESS", "COMPLETED"] as const) {
      mockFindUnique.mockResolvedValue({
        fingerprint: "fp-b",
        status,
        result: { id: "post-1" },
      } as never);

      // Fingerprint before status: telling a caller to retry a request that can
      // only ever conflict is worse than telling them it conflicts.
      await expect(prismaIdempotencyStore.claim(CLAIM)).resolves.toEqual({
        kind: "conflict",
      });
    }
  });

  it("takes over a row whose lease or retention has expired", async () => {
    mockCreate.mockRejectedValue(uniqueViolation());
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);

    await expect(prismaIdempotencyStore.claim(CLAIM)).resolves.toEqual({
      kind: "claimed",
    });

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { ...RECORD, expiresAt: { lt: NOW } },
      data: {
        fingerprint: "fp-a",
        claimToken: "attempt-1",
        status: "IN_PROGRESS",
        result: Prisma.DbNull,
        expiresAt: new Date("2024-01-01T00:01:00.000Z"),
      },
    });
    // The takeover decided it; there is nothing left to read.
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("retries the insert when the holder released the row mid-decision", async () => {
    // The winner of the race failed and deleted its row before this attempt
    // read it. The key is genuinely free, so inserting again is right.
    mockCreate
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce({} as never);
    mockFindUnique.mockResolvedValue(null as never);

    await expect(prismaIdempotencyStore.claim(CLAIM)).resolves.toEqual({
      kind: "claimed",
    });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("gives up as in flight rather than spinning on a persistent race", async () => {
    mockCreate.mockRejectedValue(uniqueViolation());
    mockFindUnique.mockResolvedValue(null as never);

    await expect(prismaIdempotencyStore.claim(CLAIM)).resolves.toEqual({
      kind: "in_flight",
    });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("propagates a failure that is not a unique violation", async () => {
    mockCreate.mockRejectedValue(new Error("connection refused"));

    await expect(prismaIdempotencyStore.claim(CLAIM)).rejects.toThrow(
      "connection refused",
    );
  });
});

describe("complete", () => {
  it("records the result against this attempt's claim only", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);

    await prismaIdempotencyStore.complete(RECORD, {
      token: "attempt-1",
      result: { id: "post-1" },
      now: NOW,
      retentionMs: 3_600_000,
    });

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { ...RECORD, claimToken: "attempt-1" },
      data: {
        status: "COMPLETED",
        result: { id: "post-1" },
        expiresAt: new Date("2024-01-01T01:00:00.000Z"),
      },
    });
  });

  it("writes SQL NULL for a handler that returned nothing", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);

    await prismaIdempotencyStore.complete(RECORD, {
      token: "attempt-1",
      result: undefined,
      now: NOW,
      retentionMs: 3_600_000,
    });

    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ result: Prisma.DbNull }),
      }),
    );
  });

  it("does not fail when the claim has already been taken over", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 } as never);

    await expect(
      prismaIdempotencyStore.complete(RECORD, {
        token: "stale-attempt",
        result: { id: "post-1" },
        now: NOW,
        retentionMs: 3_600_000,
      }),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("release", () => {
  it("deletes only a row this attempt still holds", async () => {
    await prismaIdempotencyStore.release(RECORD, "attempt-1");

    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { ...RECORD, claimToken: "attempt-1", status: "IN_PROGRESS" },
    });
  });

  it("is silent when there is nothing to delete", async () => {
    // `deleteMany`, not `delete`: this runs on a failure path, and throwing
    // over a missing row would stack a second error on the one being reported.
    mockDeleteMany.mockResolvedValue({ count: 0 } as never);

    await expect(
      prismaIdempotencyStore.release(RECORD, "attempt-1"),
    ).resolves.toBeUndefined();
  });
});
