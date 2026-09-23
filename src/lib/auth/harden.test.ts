import { describe, expect, it, vi, beforeEach } from "vitest";
import { hardenSessionToken } from "@/lib/auth/harden";
import {
  SESSION_ABSOLUTE_MAX_AGE_S,
  SESSION_ROTATION_GRACE_S,
  SESSION_ROTATION_INTERVAL_S,
} from "@/lib/auth/policy";
import { MemorySessionRegistry } from "@/lib/auth/registry";
import type { HardenDeps, SessionSecurityEvent } from "@/lib/auth/harden";
import type { JWT } from "@auth/core/jwt";

const START = new Date("2026-09-23T12:00:00.000Z");

/**
 * A controllable clock and id source.
 *
 * Both are injected rather than stubbed globally because every case below is
 * about a boundary — one second inside a window, one second outside — and a
 * test that reached for the real clock would be asserting on how long it took
 * to run.
 */
function makeDeps(registry = new MemorySessionRegistry()) {
  let clock = START;
  let counter = 0;
  const events: SessionSecurityEvent[] = [];

  const deps: HardenDeps = {
    registry,
    now: () => clock,
    newId: () => `id-${(counter += 1)}`,
    report: (event) => events.push(event),
  };

  return {
    deps,
    registry,
    events,
    types: () => events.map((event) => event.type),
    advance(seconds: number) {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
  };
}

/** Signs in and returns the token the browser would be carrying. */
async function signIn(
  harness: ReturnType<typeof makeDeps>,
  token: JWT = { id: "u-1", role: "USER" },
) {
  const result = await hardenSessionToken(
    { token, user: { id: "u-1" }, mayRotate: false },
    harness.deps,
  );
  if (result === null) throw new Error("sign-in was refused");
  return result;
}

describe("signing in", () => {
  it("mints all four claims and registers the family", async () => {
    const harness = makeDeps();
    const token = await signIn(harness);

    expect(token.sid).toBe("id-1");
    expect(token.tid).toBe("id-2");
    expect(token.sat).toBe(Math.floor(START.getTime() / 1000));
    expect(token.rat).toBe(token.sat);

    const row = await harness.registry.find("id-1");
    expect(row).toMatchObject({ userId: "u-1", currentTokenId: "id-2" });
    expect(harness.types()).toEqual(["session_started"]);
  });

  it("refuses a sign-in with no user id", async () => {
    // There would be nobody to revoke the session for. A session that cannot be
    // tied to a user is one "sign out everywhere" can never reach.
    const harness = makeDeps();
    const result = await hardenSessionToken(
      { token: {} as JWT, user: {}, mayRotate: false },
      harness.deps,
    );
    expect(result).toBeNull();
  });

  it("falls back to the id the application already put on the token", async () => {
    const harness = makeDeps();
    const result = await hardenSessionToken(
      { token: { id: "u-9" } as JWT, user: {}, mayRotate: false },
      harness.deps,
    );
    expect(result?.sid).toBe("id-1");
    expect(await harness.registry.find("id-1")).toMatchObject({
      userId: "u-9",
    });
  });
});

describe("verifying an established session", () => {
  it("serves the current token unchanged", async () => {
    const harness = makeDeps();
    const token = await signIn(harness);

    const result = await hardenSessionToken(
      { token: { ...token }, mayRotate: true },
      harness.deps,
    );

    expect(result?.tid).toBe(token.tid);
    expect(harness.types()).toEqual(["session_started"]);
  });

  it("refuses a token carrying no claims", async () => {
    const harness = makeDeps();
    const result = await hardenSessionToken(
      { token: { id: "u-1" } as JWT, mayRotate: true },
      harness.deps,
    );

    expect(result).toBeNull();
    expect(harness.types()).toEqual(["token_unclaimed"]);
  });

  it("refuses a token whose family has no row", async () => {
    // A `sid` the registry has never heard of, or has swept. Adopting it into a
    // fresh family would let a stolen cookie launder itself into a registered
    // session, which is the capability this whole module removes.
    const harness = makeDeps();
    const seconds = Math.floor(START.getTime() / 1000);
    const result = await hardenSessionToken(
      {
        token: { sid: "ghost", tid: "t", sat: seconds, rat: seconds } as JWT,
        mayRotate: true,
      },
      harness.deps,
    );

    expect(result).toBeNull();
    expect(harness.types()).toEqual(["session_unknown"]);
  });

  it("refuses a revoked family", async () => {
    const harness = makeDeps();
    const token = await signIn(harness);
    await harness.registry.revoke("id-1", "SIGNED_OUT", START);

    const result = await hardenSessionToken(
      { token: { ...token }, mayRotate: true },
      harness.deps,
    );

    expect(result).toBeNull();
    expect(harness.types()).toContain("session_revoked");
  });
});

describe("the absolute deadline", () => {
  it("ends a session that has been active throughout", async () => {
    const harness = makeDeps();
    const token = await signIn(harness);

    harness.advance(SESSION_ABSOLUTE_MAX_AGE_S);
    const result = await hardenSessionToken(
      { token: { ...token }, mayRotate: true },
      harness.deps,
    );

    expect(result).toBeNull();
    expect(harness.types()).toContain("session_absolutely_expired");
    expect(await harness.registry.find("id-1")).toMatchObject({
      revokedAt: expect.any(Date),
    });
  });

  it("is enforced before the registry is consulted", async () => {
    // The one bound that still holds when the database is unreachable: `sat` is
    // inside the encrypted token, so nothing has to be read to apply it. A
    // registry that throws must not turn an expired session into a live one.
    const registry = new MemorySessionRegistry();
    const harness = makeDeps(registry);
    const token = await signIn(harness);
    const find = vi
      .spyOn(registry, "find")
      .mockRejectedValue(new Error("database down"));

    harness.advance(SESSION_ABSOLUTE_MAX_AGE_S + 1);
    const result = await hardenSessionToken(
      { token: { ...token }, mayRotate: true },
      harness.deps,
    );

    expect(result).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });
});

describe("rotation", () => {
  it("does not rotate before the interval", async () => {
    const harness = makeDeps();
    const token = await signIn(harness);

    harness.advance(SESSION_ROTATION_INTERVAL_S - 1);
    const result = await hardenSessionToken(
      { token: { ...token }, mayRotate: true },
      harness.deps,
    );

    expect(result?.tid).toBe(token.tid);
    expect(harness.types()).not.toContain("session_rotated");
  });

  it("rotates once the interval has passed", async () => {
    const harness = makeDeps();
    const token = await signIn(harness);

    harness.advance(SESSION_ROTATION_INTERVAL_S);
    const result = await hardenSessionToken(
      { token: { ...token }, mayRotate: true },
      harness.deps,
    );

    expect(result?.tid).not.toBe(token.tid);
    expect(result?.sid).toBe(token.sid);
    expect(result?.sat).toBe(token.sat);
    expect(result?.rat).toBeGreaterThan(token.rat!);
    expect(await harness.registry.find("id-1")).toMatchObject({
      currentTokenId: result?.tid,
      previousTokenId: token.tid,
    });
    expect(harness.types()).toContain("session_rotated");
  });

  it("never rotates when the caller cannot set a cookie", async () => {
    // The single most important line in this file. `mayRotate` is false on the
    // Server Component path, where `next-auth` discards the `Set-Cookie` it
    // produces. Rotating there would advance the registry to a token the
    // browser never receives, and the browser's next request — carrying the
    // token it still has — would be read as reuse and revoke the session of a
    // user who did nothing wrong.
    const harness = makeDeps();
    const token = await signIn(harness);

    harness.advance(SESSION_ROTATION_INTERVAL_S * 10);
    const result = await hardenSessionToken(
      { token: { ...token }, mayRotate: false },
      harness.deps,
    );

    expect(result?.tid).toBe(token.tid);
    expect(await harness.registry.find("id-1")).toMatchObject({
      currentTokenId: token.tid,
      previousTokenId: null,
    });
  });

  it("serves the replaced token inside its grace window", async () => {
    const harness = makeDeps();
    const token = await signIn(harness);

    harness.advance(SESSION_ROTATION_INTERVAL_S);
    await hardenSessionToken(
      { token: { ...token }, mayRotate: true },
      harness.deps,
    );

    // A request that was already in flight when the rotation was sent.
    harness.advance(SESSION_ROTATION_GRACE_S - 1);
    const inFlight = await hardenSessionToken(
      { token: { ...token }, mayRotate: true },
      harness.deps,
    );

    expect(inFlight).not.toBeNull();
    expect(inFlight?.tid).toBe(token.tid);
    expect(harness.types()).not.toContain("token_reuse");
  });

  it("does not rotate again from a token inside the grace window", async () => {
    // Otherwise every in-flight request would attempt a write, and a page with
    // several parallel segments would issue a burst of them.
    const harness = makeDeps();
    const token = await signIn(harness);

    harness.advance(SESSION_ROTATION_INTERVAL_S);
    await hardenSessionToken(
      { token: { ...token }, mayRotate: true },
      harness.deps,
    );
    const afterFirst = await harness.registry.find("id-1");

    harness.advance(1);
    await hardenSessionToken(
      { token: { ...token }, mayRotate: true },
      harness.deps,
    );

    expect(await harness.registry.find("id-1")).toEqual(afterFirst);
  });
});

describe("reuse detection", () => {
  it("revokes the family when the replaced token comes back too late", async () => {
    const harness = makeDeps();
    const token = await signIn(harness);

    harness.advance(SESSION_ROTATION_INTERVAL_S);
    const rotated = await hardenSessionToken(
      { token: { ...token }, mayRotate: true },
      harness.deps,
    );

    harness.advance(SESSION_ROTATION_GRACE_S + 1);
    const replay = await hardenSessionToken(
      { token: { ...token }, mayRotate: true },
      harness.deps,
    );

    expect(replay).toBeNull();
    expect(harness.types()).toContain("token_reuse");

    // And the victim's own current token goes with it. There is no way to tell
    // which party is the user, so neither keeps the session.
    const victim = await hardenSessionToken(
      { token: { ...rotated! }, mayRotate: true },
      harness.deps,
    );
    expect(victim).toBeNull();
  });

  it("records TOKEN_REUSE rather than a generic revocation", async () => {
    const registry = new MemorySessionRegistry();
    const harness = makeDeps(registry);
    const revoke = vi.spyOn(registry, "revoke");
    const token = await signIn(harness);

    harness.advance(SESSION_ROTATION_INTERVAL_S);
    await hardenSessionToken(
      { token: { ...token }, mayRotate: true },
      harness.deps,
    );
    harness.advance(SESSION_ROTATION_GRACE_S + 1);
    await hardenSessionToken(
      { token: { ...token }, mayRotate: true },
      harness.deps,
    );

    expect(revoke).toHaveBeenCalledWith(
      "id-1",
      "TOKEN_REUSE",
      expect.any(Date),
    );
  });

  it("revokes on a token that was never in the chain at all", async () => {
    const harness = makeDeps();
    const token = await signIn(harness);

    const forged = { ...token, tid: "never-issued" };
    const result = await hardenSessionToken(
      { token: forged, mayRotate: true },
      harness.deps,
    );

    expect(result).toBeNull();
    expect(harness.types()).toContain("token_reuse");
  });
});

describe("two requests racing to rotate", () => {
  let harness: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    harness = makeDeps();
  });

  it("lets exactly one win and serves the other normally", async () => {
    // The case the compare-and-swap exists for. Both requests read the same
    // current token and both decide to rotate; if both wrote, the second would
    // overwrite `previousTokenId` and strand a token the browser is carrying.
    const token = await signIn(harness);
    harness.advance(SESSION_ROTATION_INTERVAL_S);

    const [first, second] = await Promise.all([
      hardenSessionToken(
        { token: { ...token }, mayRotate: true },
        harness.deps,
      ),
      hardenSessionToken(
        { token: { ...token }, mayRotate: true },
        harness.deps,
      ),
    ]);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const rotated = [first, second].filter((t) => t!.tid !== token.tid);
    expect(rotated).toHaveLength(1);
    expect(harness.types()).toContain("rotation_lost_race");
    expect(harness.types()).not.toContain("token_reuse");
  });

  it("leaves the loser carrying a token the registry still accepts", async () => {
    // The loser returns the token unchanged, which is now the *previous* one.
    // If that were not inside the grace window, losing a race would be
    // indistinguishable from theft.
    const token = await signIn(harness);
    harness.advance(SESSION_ROTATION_INTERVAL_S);

    await Promise.all([
      hardenSessionToken(
        { token: { ...token }, mayRotate: true },
        harness.deps,
      ),
      hardenSessionToken(
        { token: { ...token }, mayRotate: true },
        harness.deps,
      ),
    ]);

    const next = await hardenSessionToken(
      { token: { ...token }, mayRotate: true },
      harness.deps,
    );
    expect(next).not.toBeNull();
  });
});
