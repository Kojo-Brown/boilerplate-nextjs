import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/tenancy/client", () => ({
  unscopedPrisma: { sessionFamily: { updateMany: vi.fn() } },
}));

import { unscopedPrisma } from "@/lib/tenancy/client";
import {
  prismaSessionRevocationStore,
  reportSessionRevocation,
  revokeEverySession,
  type SessionRevocationEvent,
  type SessionRevocationStore,
} from "@/lib/auth/session-revocation";
import { captureLogs } from "@/test/log-lines";

const NOW = new Date("2026-03-04T05:06:07.000Z");

/**
 * A store that records what it was asked for and answers with a count.
 *
 * Hand-written rather than `vi.fn()` with a cast: the interface is two lines,
 * and a fake that implements it is checked by the compiler when the interface
 * changes, where a cast is not.
 */
function store(revoked = 3): SessionRevocationStore & {
  calls: { userId: string; now: Date }[];
} {
  const calls: { userId: string; now: Date }[] = [];
  return {
    calls,
    async revokeLiveFamilies(input) {
      calls.push(input);
      return revoked;
    },
  };
}

function collector(): {
  events: SessionRevocationEvent[];
  report: (event: SessionRevocationEvent) => void;
} {
  const events: SessionRevocationEvent[] = [];
  return { events, report: (event) => events.push(event) };
}

describe("revokeEverySession", () => {
  it("asks the store for one user, at the injected instant", async () => {
    const s = store();

    await revokeEverySession(
      { userId: "user-42" },
      { store: s, report: collector().report, now: () => NOW },
    );

    expect(s.calls).toEqual([{ userId: "user-42", now: NOW }]);
  });

  it("answers with the number of families the store ended", async () => {
    const revoked = await revokeEverySession(
      { userId: "u1" },
      { store: store(5), report: collector().report, now: () => NOW },
    );

    expect(revoked).toBe(5);
  });

  it("reports the account and the count", async () => {
    const { events, report } = collector();

    await revokeEverySession(
      { userId: "u1" },
      { store: store(5), report, now: () => NOW },
    );

    expect(events).toEqual([{ userId: "u1", revoked: 5 }]);
  });

  it("reports a revocation that ended nothing", async () => {
    // Zero is a real answer — every family had already ended — and it is worth
    // a line for the same reason the password change logs its refusals: the
    // event somebody reconstructs a timeline from is the one that says what
    // did *not* happen.
    const { events, report } = collector();

    await revokeEverySession(
      { userId: "u1" },
      { store: store(0), report, now: () => NOW },
    );

    expect(events).toEqual([{ userId: "u1", revoked: 0 }]);
  });

  it("reports nothing when the write failed, and lets the failure through", async () => {
    // A line claiming five sessions ended, written beside a statement that
    // threw, is worse than no line. The caller needs the throw: it is what
    // stops `signOutEverywhereAction` signing this browser out after a
    // revocation that did not happen.
    const { events, report } = collector();
    const failing: SessionRevocationStore = {
      revokeLiveFamilies: () =>
        Promise.reject(new Error("connection terminated")),
    };

    await expect(
      revokeEverySession(
        { userId: "u1" },
        { store: failing, report, now: () => NOW },
      ),
    ).rejects.toThrow("connection terminated");

    expect(events).toEqual([]);
  });
});

describe("reportSessionRevocation", () => {
  const logs = captureLogs();

  afterEach(() => {
    logs.error.length = 0;
    logs.warn.length = 0;
    logs.lines.length = 0;
  });

  it("writes one warn line under the published event name", () => {
    // The name is what an operator filters on — `docs/session-hardening.md`
    // tells them to — so it is asserted rather than left to the call site.
    reportSessionRevocation({ userId: "u1", revoked: 2 });

    expect(logs.warn).toHaveLength(1);
    expect(logs.parsed()).toEqual({
      level: "warn",
      event: "session_revocation",
      userId: "u1",
      revoked: 2,
    });
  });
});

describe("prismaSessionRevocationStore", () => {
  const client = vi.mocked(
    (
      unscopedPrisma as unknown as {
        sessionFamily: { updateMany: ReturnType<typeof vi.fn> };
      }
    ).sessionFamily.updateMany,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    client.mockResolvedValue({ count: 2 });
  });

  it("ends every family of the user that has not ended already", async () => {
    await prismaSessionRevocationStore.revokeLiveFamilies({
      userId: "user-42",
      now: NOW,
    });

    expect(client).toHaveBeenCalledWith({
      where: { userId: "user-42", revokedAt: null },
      data: { revokedAt: NOW, revokedReason: "REVOKED_BY_USER" },
    });
  });

  it("keys the predicate on the user and not on one family", async () => {
    // The narrow version is the one that looks like it works: the person who
    // pressed the button is signed out, so the feature appears to do
    // something, and the sessions it exists to end are exactly the ones left
    // running. The same regression rule R7 of
    // `scripts/assert-session-hardening.ts` guards for the password change.
    await prismaSessionRevocationStore.revokeLiveFamilies({
      userId: "user-42",
      now: NOW,
    });

    const [{ where }] = client.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(where).toHaveProperty("userId", "user-42");
    expect(where).not.toHaveProperty("id");
  });

  it("does not relabel a family that ended in token reuse", async () => {
    await prismaSessionRevocationStore.revokeLiveFamilies({
      userId: "u1",
      now: NOW,
    });

    const [{ where }] = client.mock.calls[0] as [
      { where: { revokedAt: unknown } },
    ];
    expect(where.revokedAt).toBeNull();
  });

  it("answers with the number of rows the statement updated", async () => {
    client.mockResolvedValue({ count: 7 });

    await expect(
      prismaSessionRevocationStore.revokeLiveFamilies({
        userId: "u1",
        now: NOW,
      }),
    ).resolves.toBe(7);
  });
});
