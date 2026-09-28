import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/tenancy/client", () => ({
  unscopedPrisma: { user: { updateMany: vi.fn() } },
}));

import { unscopedPrisma } from "@/lib/tenancy/client";
import {
  upgradePasswordHash,
  prismaPasswordStore,
  reportPasswordUpgrade,
  type PasswordStore,
  type PasswordUpgradeEvent,
} from "@/lib/auth/password-upgrade";
import {
  hashPassword,
  needsRehash,
  verifyPassword,
  type ScryptParameters,
} from "@/lib/password";

/** Cheap enough to hash inside a test; the cost is not what is under test. */
const OLD: ScryptParameters = { ln: 1, r: 1, p: 1 };
const NEW: ScryptParameters = { ln: 2, r: 1, p: 1 };

/** Records every call and hands back whatever the case needs. */
function store(replace: PasswordStore["replaceHash"]) {
  const calls: { userId: string; from: string; to: string }[] = [];
  const impl: PasswordStore = {
    replaceHash: async (input) => {
      calls.push(input);
      return replace(input);
    },
  };
  return { store: impl, calls };
}

function collector() {
  const events: PasswordUpgradeEvent[] = [];
  return {
    events,
    report: (event: PasswordUpgradeEvent) => events.push(event),
  };
}

describe("upgradePasswordHash", () => {
  it("writes nothing when the stored hash already meets policy", async () => {
    const stored = await hashPassword("pw", NEW);
    const { store: s, calls } = store(async () => 1);
    const { events, report } = collector();

    const outcome = await upgradePasswordHash(
      { userId: "u1", storedHash: stored, password: "pw" },
      { store: s, report, policy: NEW },
    );

    expect(outcome).toBe("current");
    expect(calls).toEqual([]);
    expect(events).toEqual([{ outcome: "current", userId: "u1" }]);
  });

  it("re-derives a below-policy hash and writes it at the new cost", async () => {
    const stored = await hashPassword("pw", OLD);
    expect(needsRehash(stored, NEW)).toBe(true);

    const { store: s, calls } = store(async () => 1);
    const { events, report } = collector();

    const outcome = await upgradePasswordHash(
      { userId: "u1", storedHash: stored, password: "pw" },
      { store: s, report, policy: NEW },
    );

    expect(outcome).toBe("upgraded");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.from).toBe(stored);
    expect(calls[0]?.to).toContain("ln=2,r=1,p=1");
    expect(events).toEqual([{ outcome: "upgraded", userId: "u1" }]);
  });

  it("writes a replacement the same password still verifies against", async () => {
    // The failure this rules out is the one that locks everybody out: an
    // upgrade that writes a hash of the wrong thing is invisible until the
    // next sign-in, by which time the old hash is gone.
    const stored = await hashPassword("correct horse", OLD);
    const { store: s, calls } = store(async () => 1);

    await upgradePasswordHash(
      { userId: "u1", storedHash: stored, password: "correct horse" },
      { store: s, report: () => {}, policy: NEW },
    );

    const written = calls[0]?.to ?? "";
    await expect(verifyPassword("correct horse", written)).resolves.toBe(true);
    await expect(verifyPassword("wrong", written)).resolves.toBe(false);
    expect(needsRehash(written, NEW)).toBe(false);
  });

  it("names the hash it verified against, so a concurrent change wins", async () => {
    // The store reports 0 rows changed: a password change landed between the
    // read and this write. Overwriting it would revert somebody's password
    // change to the password they had just replaced.
    const stored = await hashPassword("pw", OLD);
    const { store: s, calls } = store(async () => 0);
    const { events, report } = collector();

    const outcome = await upgradePasswordHash(
      { userId: "u1", storedHash: stored, password: "pw" },
      { store: s, report, policy: NEW },
    );

    expect(outcome).toBe("superseded");
    expect(calls[0]?.from).toBe(stored);
    expect(events).toEqual([{ outcome: "superseded", userId: "u1" }]);
  });

  it("swallows a write failure, because the sign-in already succeeded", async () => {
    const stored = await hashPassword("pw", OLD);
    const { store: s } = store(async () => {
      throw new Error("connection terminated unexpectedly");
    });
    const { events, report } = collector();

    const outcome = await upgradePasswordHash(
      { userId: "u1", storedHash: stored, password: "pw" },
      { store: s, report, policy: NEW },
    );

    expect(outcome).toBe("failed");
    expect(events[0]).toMatchObject({ outcome: "failed", userId: "u1" });
  });

  it("never puts the password or a hash into the event it reports", async () => {
    // A driver that echoes the failing statement's bound parameters. Postgres
    // clients do this, and on this call path the parameters are a password
    // hash — so carrying the message through would log one.
    const stored = await hashPassword("hunter2", OLD);
    const { store: s } = store(async () => {
      const error = new Error(
        `error writing "${stored}" for user u1 (password "hunter2")`,
      );
      error.name = "PrismaClientKnownRequestError";
      Object.assign(error, { code: "P2024" });
      throw error;
    });
    const { events, report } = collector();

    await upgradePasswordHash(
      { userId: "u1", storedHash: stored, password: "hunter2" },
      { store: s, report, policy: NEW },
    );

    const serialised = JSON.stringify(events[0]);
    expect(serialised).not.toContain("hunter2");
    expect(serialised).not.toContain(stored);
    expect(serialised).not.toContain("$scrypt$");
    // Still enough to tell a pool timeout from a constraint violation.
    expect(events[0]?.error).toBe("PrismaClientKnownRequestError (P2024)");
  });

  it("upgrades a hash in the previous parameterless format", async () => {
    // What every existing row in a deployed database looks like.
    const legacy =
      "5bd513b9adfea3c9e53b".padEnd(128, "0") + "." + "a".repeat(32);
    const { store: s, calls } = store(async () => 1);

    const outcome = await upgradePasswordHash(
      { userId: "u1", storedHash: legacy, password: "pw" },
      { store: s, report: () => {}, policy: NEW },
    );

    expect(outcome).toBe("upgraded");
    expect(calls[0]?.from).toBe(legacy);
    expect(calls[0]?.to.startsWith("$scrypt$")).toBe(true);
  });
});

describe("prismaPasswordStore", () => {
  beforeEach(() => {
    vi.mocked(unscopedPrisma.user.updateMany).mockReset();
  });

  it("issues a compare-and-set and returns the row count", async () => {
    vi.mocked(unscopedPrisma.user.updateMany).mockResolvedValue({ count: 1 });

    await expect(
      prismaPasswordStore.replaceHash({ userId: "u1", from: "old", to: "new" }),
    ).resolves.toBe(1);

    // `password: from` in the predicate is the whole of the concurrency
    // control. Dropping it leaves a statement that passes every other
    // assertion here and reverts password changes in production.
    expect(unscopedPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", password: "old" },
      data: { password: "new" },
    });
  });

  it("reports zero when the row no longer holds the hash it verified", async () => {
    vi.mocked(unscopedPrisma.user.updateMany).mockResolvedValue({ count: 0 });

    await expect(
      prismaPasswordStore.replaceHash({ userId: "u1", from: "old", to: "new" }),
    ).resolves.toBe(0);
  });
});

describe("reportPasswordUpgrade", () => {
  it("says nothing on the common case of a hash already at policy", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    reportPasswordUpgrade({ outcome: "current", userId: "u1" });

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it("logs an upgrade at warn and a failure at error", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    reportPasswordUpgrade({ outcome: "upgraded", userId: "u1" });
    reportPasswordUpgrade({ outcome: "failed", userId: "u1", error: "boom" });

    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: "password_rehash",
        outcome: "upgraded",
        userId: "u1",
      }),
    );
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({
        event: "password_rehash",
        outcome: "failed",
        userId: "u1",
        error: "boom",
      }),
    );
    warn.mockRestore();
    error.mockRestore();
  });
});
