import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    sessionFamily: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import {
  MemorySessionRegistry,
  PrismaSessionRegistry,
} from "@/lib/auth/registry";
import {
  SESSION_ABSOLUTE_MAX_AGE_S,
  SESSION_ROTATION_GRACE_S,
} from "@/lib/auth/policy";

const NOW = new Date("2026-09-23T12:00:00.000Z");

describe("MemorySessionRegistry", () => {
  it("starts, finds and rotates", async () => {
    const registry = new MemorySessionRegistry();
    await registry.start({ sid: "s", userId: "u", tid: "t1", now: NOW });

    expect(await registry.find("s")).toMatchObject({
      currentTokenId: "t1",
      previousTokenId: null,
      revokedAt: null,
    });

    expect(
      await registry.rotate({ sid: "s", from: "t1", to: "t2", now: NOW }),
    ).toBe(true);
    expect(await registry.find("s")).toMatchObject({
      currentTokenId: "t2",
      previousTokenId: "t1",
    });
  });

  it("refuses a rotation from a token that is no longer current", async () => {
    const registry = new MemorySessionRegistry();
    await registry.start({ sid: "s", userId: "u", tid: "t1", now: NOW });
    await registry.rotate({ sid: "s", from: "t1", to: "t2", now: NOW });

    expect(
      await registry.rotate({ sid: "s", from: "t1", to: "t3", now: NOW }),
    ).toBe(false);
    expect(await registry.find("s")).toMatchObject({ currentTokenId: "t2" });
  });

  it("refuses a rotation on a revoked family", async () => {
    const registry = new MemorySessionRegistry();
    await registry.start({ sid: "s", userId: "u", tid: "t1", now: NOW });
    await registry.revoke("s", "TOKEN_REUSE", NOW);

    expect(
      await registry.rotate({ sid: "s", from: "t1", to: "t2", now: NOW }),
    ).toBe(false);
  });

  it("returns null for an unknown family", async () => {
    expect(await new MemorySessionRegistry().find("nope")).toBeNull();
  });

  it("hands out copies, not the stored record", async () => {
    // A caller that mutated what `find` returned would silently rewrite the
    // registry, and every test built on this store would be testing itself.
    const registry = new MemorySessionRegistry();
    await registry.start({ sid: "s", userId: "u", tid: "t1", now: NOW });

    const record = await registry.find("s");
    record!.currentTokenId = "tampered";

    expect(await registry.find("s")).toMatchObject({ currentTokenId: "t1" });
  });

  it("is idempotent about revocation", async () => {
    const registry = new MemorySessionRegistry();
    await registry.start({ sid: "s", userId: "u", tid: "t", now: NOW });

    await registry.revoke("s", "TOKEN_REUSE", NOW);
    await registry.revoke("s", "SIGNED_OUT", new Date(NOW.getTime() + 1000));

    expect((await registry.find("s"))?.revokedAt).toEqual(NOW);
  });
});

describe("PrismaSessionRegistry", () => {
  const registry = new PrismaSessionRegistry();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes an absolute deadline at sign-in", async () => {
    await registry.start({ sid: "s", userId: "u", tid: "t1", now: NOW });

    expect(prisma.sessionFamily.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "s",
        userId: "u",
        currentTokenId: "t1",
        expiresAt: new Date(NOW.getTime() + SESSION_ABSOLUTE_MAX_AGE_S * 1000),
      }),
    });
  });

  it("makes the rotation conditional on the current token", async () => {
    // The compare-and-swap, and the reason this is `updateMany` rather than a
    // read followed by an `update`: the condition has to be in the statement,
    // or two concurrent requests both read `t1`, both write, and the second
    // erases the first's `previousTokenId` — stranding a token the browser is
    // already carrying and turning ordinary concurrency into a reuse incident.
    vi.mocked(prisma.sessionFamily.updateMany).mockResolvedValue({ count: 1 });

    const won = await registry.rotate({
      sid: "s",
      from: "t1",
      to: "t2",
      now: NOW,
    });

    expect(won).toBe(true);
    expect(prisma.sessionFamily.updateMany).toHaveBeenCalledWith({
      where: { id: "s", currentTokenId: "t1", revokedAt: null },
      data: expect.objectContaining({
        currentTokenId: "t2",
        previousTokenId: "t1",
        previousValidUntil: new Date(
          NOW.getTime() + SESSION_ROTATION_GRACE_S * 1000,
        ),
        rotations: { increment: 1 },
      }),
    });
  });

  it("reports losing the swap rather than throwing", async () => {
    vi.mocked(prisma.sessionFamily.updateMany).mockResolvedValue({ count: 0 });

    expect(
      await registry.rotate({ sid: "s", from: "t1", to: "t2", now: NOW }),
    ).toBe(false);
  });

  it("will not revive a family revoked between the read and the write", async () => {
    // `revokedAt: null` is in the rotation's condition for this: a sign-out
    // landing mid-rotation must win, not be overwritten by it.
    vi.mocked(prisma.sessionFamily.updateMany).mockResolvedValue({ count: 0 });
    await registry.rotate({ sid: "s", from: "t1", to: "t2", now: NOW });

    expect(prisma.sessionFamily.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revokedAt: null }),
      }),
    );
  });

  it("keeps the first revocation reason", async () => {
    // A family revoked for TOKEN_REUSE that the victim's browser then signs out
    // of must still read TOKEN_REUSE when somebody comes to look at it.
    vi.mocked(prisma.sessionFamily.updateMany).mockResolvedValue({ count: 1 });
    await registry.revoke("s", "SIGNED_OUT", NOW);

    expect(prisma.sessionFamily.updateMany).toHaveBeenCalledWith({
      where: { id: "s", revokedAt: null },
      data: { revokedAt: NOW, revokedReason: "SIGNED_OUT" },
    });
  });

  it("selects only the fields a decision is made from", async () => {
    // The row carries `lastSeenAt`, `rotations` and timestamps that no
    // authorisation decision reads. Selecting them would make this query grow
    // with the model.
    vi.mocked(prisma.sessionFamily.findUnique).mockResolvedValue(null);
    await registry.find("s");

    const call = vi.mocked(prisma.sessionFamily.findUnique).mock.calls[0]![0]!;
    expect(Object.keys(call.select!).sort()).toEqual([
      "currentTokenId",
      "id",
      "previousTokenId",
      "previousValidUntil",
      "revokedAt",
      "userId",
    ]);
  });
});
