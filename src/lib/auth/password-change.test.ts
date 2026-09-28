import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/tenancy/client", () => ({
  unscopedPrisma: {
    $transaction: vi.fn(),
    user: { findUnique: vi.fn(), updateMany: vi.fn() },
    sessionFamily: { updateMany: vi.fn() },
  },
}));

import { unscopedPrisma } from "@/lib/tenancy/client";
import {
  changeUserPassword,
  prismaPasswordChangeStore,
  reportPasswordChange,
  type PasswordChangeEvent,
  type PasswordChangeStore,
} from "@/lib/auth/password-change";
import {
  needsRehash,
  hashPassword,
  parsePasswordHash,
  verifyPassword,
  PASSWORD_HASH_POLICY,
  type ScryptParameters,
} from "@/lib/password";

/**
 * Cheap enough to derive inside a test. The cost of the hash is not what is
 * under test here — `assert-password-hashing.ts` and `password.test.ts` own
 * that — with one exception, marked below, which needs the real policy because
 * the claim is about the default.
 */
const CHEAP: ScryptParameters = { ln: 2, r: 1, p: 1 };

/**
 * The fixture credentials, named once.
 *
 * Constants rather than the literals they replaced, for two reasons. They were
 * repeated thirty-one times, so the file read as if the strings mattered when
 * what matters is which of the three a call site passes. And the literals were
 * `CURRENT` and `WRONG` next to a `userId` on the same line, which is
 * a credential pair to a secret scanner: GitGuardian reported four findings
 * against this file on the pull request that added it. Nothing here was ever a
 * secret, and now nothing here looks like one either — which is what CLAUDE.md
 * asks of a fixture.
 */
const CURRENT = "fixture-current-not-a-secret";
const REPLACEMENT = "fixture-replacement-not-a-secret";
const WRONG = "fixture-wrong-guess";

const NOW = new Date("2026-03-01T12:00:00.000Z");

interface StoreCall {
  userId: string;
  from: string;
  to: string;
  now: Date;
}

/**
 * A store that records what it was asked to do.
 *
 * `write` decides the outcome: a number is "the swap won and revoked that many
 * families", `null` is "the row no longer held `from`".
 */
function store(
  hash: string | null,
  write: number | null | (() => never) = 2,
): { store: PasswordChangeStore; calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  return {
    calls,
    store: {
      findPasswordHash: async () => hash,
      replaceHashAndRevokeSessions: async (input) => {
        calls.push(input);
        if (typeof write === "function") return write();
        return write;
      },
    },
  };
}

function collector() {
  const events: PasswordChangeEvent[] = [];
  return { events, report: (event: PasswordChangeEvent) => events.push(event) };
}

function deps(
  s: PasswordChangeStore,
  report: (event: PasswordChangeEvent) => void,
  policy: ScryptParameters | undefined = CHEAP,
) {
  return { store: s, report, now: () => NOW, policy };
}

describe("changeUserPassword", () => {
  it("replaces the hash and reports the sessions it ended", async () => {
    const stored = await hashPassword(CURRENT, CHEAP);
    const { store: s, calls } = store(stored, 3);
    const { events, report } = collector();

    const outcome = await changeUserPassword(
      {
        userId: "u1",
        currentPassword: CURRENT,
        newPassword: REPLACEMENT,
      },
      deps(s, report),
    );

    expect(outcome).toEqual({ kind: "changed", sessionsRevoked: 3 });
    expect(calls).toHaveLength(1);
    expect(events).toEqual([
      { outcome: "changed", userId: "u1", sessionsRevoked: 3 },
    ]);
  });

  it("writes a hash of the new password and not of the old one", async () => {
    const stored = await hashPassword(CURRENT, CHEAP);
    const { store: s, calls } = store(stored);
    const { report } = collector();

    await changeUserPassword(
      {
        userId: "u1",
        currentPassword: CURRENT,
        newPassword: REPLACEMENT,
      },
      deps(s, report),
    );

    const written = calls[0]?.to as string;
    await expect(verifyPassword(REPLACEMENT, written)).resolves.toBe(true);
    await expect(verifyPassword(CURRENT, written)).resolves.toBe(false);
  });

  it("names the verified hash as the condition of the write", async () => {
    // The compare-and-set. If `from` were re-read from the row instead, a
    // verify-then-rehash landing between the two statements would be
    // overwritten with a derivation of the old password — reverting a change
    // its owner believes they have made.
    const stored = await hashPassword(CURRENT, CHEAP);
    const { store: s, calls } = store(stored);
    const { report } = collector();

    await changeUserPassword(
      {
        userId: "u1",
        currentPassword: CURRENT,
        newPassword: REPLACEMENT,
      },
      deps(s, report),
    );

    expect(calls[0]?.from).toBe(stored);
    expect(calls[0]?.userId).toBe("u1");
    expect(calls[0]?.now).toBe(NOW);
  });

  it("derives the replacement at the current policy by default", async () => {
    // The one case that pays for a real derivation, because the claim is about
    // what happens when no policy is passed: a change that landed below policy
    // would be a downgrade performed on the person's behalf, and `needsRehash`
    // would then want to replace it on their next sign-in.
    const stored = await hashPassword(CURRENT, CHEAP);
    const { store: s, calls } = store(stored);
    const { report } = collector();

    await changeUserPassword(
      {
        userId: "u1",
        currentPassword: CURRENT,
        newPassword: REPLACEMENT,
      },
      { store: s, report, now: () => NOW },
    );

    const written = calls[0]?.to as string;
    expect(parsePasswordHash(written)?.params).toEqual(PASSWORD_HASH_POLICY);
    expect(needsRehash(written)).toBe(false);
  });

  it("refuses an account that has no password, without deriving one", async () => {
    const { store: s, calls } = store(null);
    const { events, report } = collector();

    const outcome = await changeUserPassword(
      { userId: "u1", currentPassword: WRONG, newPassword: REPLACEMENT },
      deps(s, report),
    );

    expect(outcome).toEqual({ kind: "no_password" });
    expect(calls).toEqual([]);
    expect(events).toEqual([{ outcome: "no_password", userId: "u1" }]);
  });

  it("refuses a wrong current password and writes nothing", async () => {
    const stored = await hashPassword(CURRENT, CHEAP);
    const { store: s, calls } = store(stored);
    const { events, report } = collector();

    const outcome = await changeUserPassword(
      { userId: "u1", currentPassword: WRONG, newPassword: REPLACEMENT },
      deps(s, report),
    );

    expect(outcome).toEqual({ kind: "incorrect" });
    expect(calls).toEqual([]);
    expect(events).toEqual([{ outcome: "incorrect", userId: "u1" }]);
  });

  it("refuses a new password equal to the current one", async () => {
    // Otherwise "sign out everywhere" would be reachable as a no-op change:
    // every session ends and the credential is exactly as compromised as it
    // was, which is the one outcome a person doing this does not want.
    const stored = await hashPassword(CURRENT, CHEAP);
    const { store: s, calls } = store(stored);
    const { events, report } = collector();

    const outcome = await changeUserPassword(
      {
        userId: "u1",
        currentPassword: CURRENT,
        newPassword: CURRENT,
      },
      deps(s, report),
    );

    expect(outcome).toEqual({ kind: "reused" });
    expect(calls).toEqual([]);
    expect(events).toEqual([{ outcome: "reused", userId: "u1" }]);
  });

  it("reports a wrong current password ahead of a reused one", async () => {
    const stored = await hashPassword(CURRENT, CHEAP);
    const { store: s } = store(stored);
    const { report } = collector();

    const outcome = await changeUserPassword(
      { userId: "u1", currentPassword: WRONG, newPassword: WRONG },
      deps(s, report),
    );

    expect(outcome).toEqual({ kind: "incorrect" });
  });

  it("reports a lost swap rather than retrying it", async () => {
    const stored = await hashPassword(CURRENT, CHEAP);
    const { store: s, calls } = store(stored, null);
    const { events, report } = collector();

    const outcome = await changeUserPassword(
      {
        userId: "u1",
        currentPassword: CURRENT,
        newPassword: REPLACEMENT,
      },
      deps(s, report),
    );

    expect(outcome).toEqual({ kind: "superseded" });
    expect(calls).toHaveLength(1);
    expect(events).toEqual([{ outcome: "superseded", userId: "u1" }]);
  });

  it("lets a write failure reach the caller", async () => {
    // The opposite policy to `upgradePasswordHash`, which swallows its write
    // error because the sign-in it runs inside must not fail over a cost
    // parameter. Here the write *is* the request: a swallowed failure would
    // tell somebody their password had changed when it had not.
    const stored = await hashPassword(CURRENT, CHEAP);
    const { store: s } = store(stored, () => {
      throw new Error("connection terminated");
    });
    const { report } = collector();

    await expect(
      changeUserPassword(
        {
          userId: "u1",
          currentPassword: CURRENT,
          newPassword: REPLACEMENT,
        },
        deps(s, report),
      ),
    ).rejects.toThrow("connection terminated");
  });

  it("never puts either password in an event", async () => {
    const stored = await hashPassword(CURRENT, CHEAP);
    const { store: s } = store(stored);
    const { events, report } = collector();

    await changeUserPassword(
      {
        userId: "u1",
        currentPassword: CURRENT,
        newPassword: REPLACEMENT,
      },
      deps(s, report),
    );

    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain(CURRENT);
    expect(serialised).not.toContain(REPLACEMENT);
  });
});

describe("prismaPasswordChangeStore", () => {
  const client = vi.mocked(
    unscopedPrisma as unknown as {
      $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
      user: { findUnique: ReturnType<typeof vi.fn> };
    },
  );

  /** A transaction client that records what it was asked to write. */
  function transaction(userCount: number, revokedCount: number) {
    const user = {
      updateMany: vi.fn().mockResolvedValue({ count: userCount }),
    };
    const sessionFamily = {
      updateMany: vi.fn().mockResolvedValue({ count: revokedCount }),
    };

    vi.mocked(client.$transaction).mockImplementation(
      async (fn) => fn({ user, sessionFamily }) as Promise<unknown>,
    );

    return { user, sessionFamily };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the stored hash for one user", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue({ password: "$hash" });

    await expect(
      prismaPasswordChangeStore.findPasswordHash("u1"),
    ).resolves.toBe("$hash");
    expect(client.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: { password: true },
    });
  });

  it("answers null for a row with no password", async () => {
    // An OAuth-only account. The same answer as a missing row, because in both
    // cases there is no credential to verify against.
    vi.mocked(client.user.findUnique).mockResolvedValue({ password: null });

    await expect(
      prismaPasswordChangeStore.findPasswordHash("u1"),
    ).resolves.toBeNull();
  });

  it("writes the hash and revokes the families in one transaction", async () => {
    const tx = transaction(1, 4);

    const revoked =
      await prismaPasswordChangeStore.replaceHashAndRevokeSessions({
        userId: "u1",
        from: "$old",
        to: "$new",
        now: NOW,
      });

    expect(revoked).toBe(4);
    // Both statements on the transaction client. The singleton's own delegates
    // are what a refactor reaches for by accident, and using them would run
    // each write on its own connection — committing independently, outside the
    // transaction that is supposed to bind them.
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u1", password: "$old" },
      data: { password: "$new" },
    });
    expect(tx.sessionFamily.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", revokedAt: null },
      data: { revokedAt: NOW, revokedReason: "REVOKED_BY_USER" },
    });
  });

  it("revokes nothing when the row no longer holds the verified hash", async () => {
    const tx = transaction(0, 4);

    const revoked =
      await prismaPasswordChangeStore.replaceHashAndRevokeSessions({
        userId: "u1",
        from: "$old",
        to: "$new",
        now: NOW,
      });

    expect(revoked).toBeNull();
    // The load-bearing half: a change that did not land must not sign anybody
    // out. Ending the sessions anyway would make a lost race indistinguishable
    // from a successful change to everyone holding a cookie.
    expect(tx.sessionFamily.updateMany).not.toHaveBeenCalled();
  });

  it("leaves an earlier revocation reason in place", async () => {
    // `revokedAt: null` in the predicate. A family that ended in `TOKEN_REUSE`
    // has to keep saying so: that is the reason an operator answering "why was
    // I signed out?" needs, and this update would otherwise relabel it.
    const tx = transaction(1, 0);

    await prismaPasswordChangeStore.replaceHashAndRevokeSessions({
      userId: "u1",
      from: "$old",
      to: "$new",
      now: NOW,
    });

    const [call] = tx.sessionFamily.updateMany.mock.calls;
    expect((call?.[0] as { where: { revokedAt: null } }).where.revokedAt).toBe(
      null,
    );
  });
});

describe("reportPasswordChange", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a successful change at warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    reportPasswordChange({
      outcome: "changed",
      userId: "u1",
      sessionsRevoked: 2,
    });

    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: "password_change",
        outcome: "changed",
        userId: "u1",
        sessionsRevoked: 2,
      }),
    );
  });

  it("logs a refusal at error", async () => {
    // A signed-in caller guessing at the password of the account they are
    // already in is the line somebody reconstructs a timeline from.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    reportPasswordChange({ outcome: "incorrect", userId: "u1" });

    expect(error).toHaveBeenCalledWith(
      JSON.stringify({
        event: "password_change",
        outcome: "incorrect",
        userId: "u1",
      }),
    );
  });
});
