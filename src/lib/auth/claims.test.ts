import { describe, expect, it } from "vitest";
import {
  readSessionClaims,
  toEpochSeconds,
  writeSessionClaims,
} from "@/lib/auth/claims";
import type { JWT } from "@auth/core/jwt";

const complete = {
  sid: "s-1",
  tid: "t-1",
  sat: 1_700_000_000,
  rat: 1_700_000_100,
};

describe("readSessionClaims", () => {
  it("reads a complete set", () => {
    expect(readSessionClaims({ ...complete } as JWT)).toEqual(complete);
  });

  it.each(["sid", "tid", "sat", "rat"] as const)(
    "refuses a token missing %s",
    (missing) => {
      const token = { ...complete } as Record<string, unknown>;
      delete token[missing];
      expect(readSessionClaims(token as JWT)).toBeNull();
    },
  );

  it("refuses an empty string id", () => {
    // Distinct from absent, and worth its own case: `""` is a string, so a
    // `typeof` check alone would let it through and it would then match no row.
    expect(readSessionClaims({ ...complete, sid: "" } as JWT)).toBeNull();
    expect(readSessionClaims({ ...complete, tid: "" } as JWT)).toBeNull();
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a fraction", 1.5],
    ["a negative", -1],
    ["a string", "1700000000"],
  ])("refuses %s as a time claim", (_label, value) => {
    // The reason these are rejected rather than coerced: `NaN` and `Infinity`
    // make every comparison in the policy return false, and for
    // `isAbsolutelyExpired` false means "still valid". A malformed numeric
    // claim must not be the one that fails open.
    expect(readSessionClaims({ ...complete, sat: value } as JWT)).toBeNull();
    expect(readSessionClaims({ ...complete, rat: value } as JWT)).toBeNull();
  });

  it("refuses a token carrying none of them", () => {
    // The token every session minted before this feature shipped looks like.
    expect(readSessionClaims({ id: "u-1", role: "USER" } as JWT)).toBeNull();
  });
});

describe("writeSessionClaims", () => {
  it("round-trips through readSessionClaims", () => {
    const token = writeSessionClaims({ id: "u-1" } as JWT, complete);
    expect(readSessionClaims(token)).toEqual(complete);
  });

  it("leaves the application's own claims alone", () => {
    const token = writeSessionClaims(
      { id: "u-1", role: "ADMIN" } as JWT,
      complete,
    );
    expect(token.id).toBe("u-1");
    expect(token.role).toBe("ADMIN");
  });

  it("does not write a `jti`", () => {
    // `@auth/core`'s `encode` ends with `.setJti(crypto.randomUUID())`, which
    // overwrites that claim after the callback has returned. A token id stored
    // there never survives into the cookie, so every request would present an
    // id the registry has never seen and reuse detection would revoke the
    // session on the first page load after signing in — which is exactly what
    // happened before this moved to `tid`. See the header of `claims.ts`.
    const token = writeSessionClaims({} as JWT, complete) as Record<
      string,
      unknown
    >;
    expect(token["jti"]).toBeUndefined();
    expect(token["tid"]).toBe("t-1");
  });
});

describe("toEpochSeconds", () => {
  it("floors rather than rounds", () => {
    // Rounding up would put a freshly minted `sat` in the future, which makes
    // `isAbsolutelyExpired` compare against a negative age for a fraction of a
    // second. Harmless, but flooring means the claim is never ahead of the
    // clock that wrote it.
    expect(toEpochSeconds(new Date(1_700_000_000_999))).toBe(1_700_000_000);
  });
});
