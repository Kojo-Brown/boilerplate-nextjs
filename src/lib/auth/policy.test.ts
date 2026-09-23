import { describe, expect, it } from "vitest";
import {
  SESSION_ABSOLUTE_MAX_AGE_S,
  SESSION_IDLE_MAX_AGE_S,
  SESSION_ROTATION_GRACE_S,
  SESSION_ROTATION_INTERVAL_S,
  absoluteDeadline,
  classifyToken,
  graceDeadline,
  isAbsolutelyExpired,
  isRotationDue,
} from "@/lib/auth/policy";
import type { SessionClaims } from "@/lib/auth/claims";
import type { SessionFamilyRecord } from "@/lib/auth/registry";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);

function claims(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    sid: "s-1",
    tid: "t-1",
    sat: nowSeconds,
    rat: nowSeconds,
    ...overrides,
  };
}

function record(
  overrides: Partial<SessionFamilyRecord> = {},
): SessionFamilyRecord {
  return {
    id: "s-1",
    userId: "u-1",
    currentTokenId: "t-2",
    previousTokenId: null,
    previousValidUntil: null,
    revokedAt: null,
    ...overrides,
  };
}

describe("the durations are ordered", () => {
  // Not decoration. Each of these orderings is load-bearing, and getting one
  // backwards produces a system that works in testing and misbehaves in use.
  it("grace is shorter than the rotation interval", () => {
    // Otherwise two grace windows could overlap and one token could be the
    // "previous" of two different rotations at once.
    expect(SESSION_ROTATION_GRACE_S).toBeLessThan(SESSION_ROTATION_INTERVAL_S);
  });

  it("the rotation interval is shorter than the idle window", () => {
    // Otherwise a session would reach its idle deadline before it ever rotated,
    // and rotation would be dead code.
    expect(SESSION_ROTATION_INTERVAL_S).toBeLessThan(SESSION_IDLE_MAX_AGE_S);
  });

  it("the idle window does not outlast the absolute one", () => {
    // Otherwise the absolute deadline could not be reached by an idle session:
    // the cookie would expire first and the bound would never bind.
    expect(SESSION_IDLE_MAX_AGE_S).toBeLessThanOrEqual(
      SESSION_ABSOLUTE_MAX_AGE_S,
    );
  });

  it("is shorter than Auth.js's 30-day default in both dimensions", () => {
    const thirtyDays = 60 * 60 * 24 * 30;
    expect(SESSION_IDLE_MAX_AGE_S).toBeLessThan(thirtyDays);
    expect(SESSION_ABSOLUTE_MAX_AGE_S).toBeLessThan(thirtyDays);
  });
});

describe("classifyToken", () => {
  it("calls the registry's current token current", () => {
    expect(
      classifyToken(record({ currentTokenId: "t-1" }), "t-1", NOW),
    ).toEqual({ kind: "current" });
  });

  it("calls an absent row unknown", () => {
    expect(classifyToken(null, "t-1", NOW)).toEqual({ kind: "unknown" });
  });

  it("calls the previous token, inside its window, grace", () => {
    const row = record({
      currentTokenId: "t-2",
      previousTokenId: "t-1",
      previousValidUntil: new Date(NOW.getTime() + 1_000),
    });
    expect(classifyToken(row, "t-1", NOW)).toEqual({ kind: "grace" });
  });

  it("accepts the previous token at the exact instant it expires", () => {
    // Inclusive, so a request arriving on the boundary is served rather than
    // treated as an incident. The asymmetry is deliberate: the cost of being
    // one millisecond generous is one extra served request; the cost of being
    // one millisecond strict is signing a user out and logging a false
    // security event.
    const row = record({
      currentTokenId: "t-2",
      previousTokenId: "t-1",
      previousValidUntil: NOW,
    });
    expect(classifyToken(row, "t-1", NOW)).toEqual({ kind: "grace" });
  });

  it("calls the previous token, past its window, reuse", () => {
    const row = record({
      currentTokenId: "t-2",
      previousTokenId: "t-1",
      previousValidUntil: new Date(NOW.getTime() - 1),
    });
    expect(classifyToken(row, "t-1", NOW)).toEqual({ kind: "reuse" });
  });

  it("calls a token from neither slot reuse", () => {
    const row = record({ currentTokenId: "t-2", previousTokenId: "t-1" });
    expect(classifyToken(row, "t-0", NOW)).toEqual({ kind: "reuse" });
  });

  it("calls a previous token with no recorded window reuse", () => {
    // `previousValidUntil` null means no rotation has happened, so a token
    // claiming to be the previous one is claiming something that never was.
    const row = record({ previousTokenId: "t-1", previousValidUntil: null });
    expect(classifyToken(row, "t-1", NOW)).toEqual({ kind: "reuse" });
  });

  it("puts revocation ahead of currency", () => {
    // The ordering that makes "sign out everywhere" take effect immediately
    // rather than at the next rotation. A revoked family's own current token
    // must not be served.
    const row = record({ currentTokenId: "t-1", revokedAt: NOW });
    expect(classifyToken(row, "t-1", NOW)).toEqual({ kind: "revoked" });
  });

  it("puts revocation ahead of the grace window too", () => {
    const row = record({
      currentTokenId: "t-2",
      previousTokenId: "t-1",
      previousValidUntil: new Date(NOW.getTime() + 10_000),
      revokedAt: NOW,
    });
    expect(classifyToken(row, "t-1", NOW)).toEqual({ kind: "revoked" });
  });
});

describe("isRotationDue", () => {
  it("is false for a token minted now", () => {
    expect(isRotationDue(claims(), NOW)).toBe(false);
  });

  it("is false one second before the interval", () => {
    const token = claims({ rat: nowSeconds - SESSION_ROTATION_INTERVAL_S + 1 });
    expect(isRotationDue(token, NOW)).toBe(false);
  });

  it("is true at the interval exactly", () => {
    const token = claims({ rat: nowSeconds - SESSION_ROTATION_INTERVAL_S });
    expect(isRotationDue(token, NOW)).toBe(true);
  });

  it("reads `rat` and not `sat`", () => {
    // A session six days old that rotated a minute ago is not due. Reading the
    // session's age here instead of the token's would rotate on every request
    // for the rest of the session's life.
    const token = claims({
      sat: nowSeconds - 60 * 60 * 24 * 6,
      rat: nowSeconds - 60,
    });
    expect(isRotationDue(token, NOW)).toBe(false);
  });
});

describe("isAbsolutelyExpired", () => {
  it("is false for a fresh session", () => {
    expect(isAbsolutelyExpired(claims(), NOW)).toBe(false);
  });

  it("is true at the deadline exactly", () => {
    const token = claims({ sat: nowSeconds - SESSION_ABSOLUTE_MAX_AGE_S });
    expect(isAbsolutelyExpired(token, NOW)).toBe(true);
  });

  it("ignores rotation", () => {
    // The whole point of the bound: a session that has been rotating happily
    // for its entire allowance still ends. `rat` is now; `sat` is not.
    const token = claims({
      sat: nowSeconds - SESSION_ABSOLUTE_MAX_AGE_S - 1,
      rat: nowSeconds,
    });
    expect(isAbsolutelyExpired(token, NOW)).toBe(true);
  });
});

describe("deadlines", () => {
  it("absoluteDeadline agrees with isAbsolutelyExpired", () => {
    // The row's `expiresAt` and the claim-based check are two expressions of
    // one rule, and a sweep keyed on a deadline the check disagrees with would
    // delete rows that still had decisions to make.
    const deadline = absoluteDeadline(NOW);
    const atDeadline = claims({ sat: nowSeconds });
    expect(isAbsolutelyExpired(atDeadline, deadline)).toBe(true);
    expect(
      isAbsolutelyExpired(atDeadline, new Date(deadline.getTime() - 1_000)),
    ).toBe(false);
  });

  it("graceDeadline is the grace window past the rotation", () => {
    expect(graceDeadline(NOW).getTime() - NOW.getTime()).toBe(
      SESSION_ROTATION_GRACE_S * 1_000,
    );
  });
});
