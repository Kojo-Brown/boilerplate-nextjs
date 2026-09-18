import { describe, it, expect } from "vitest";
import {
  COOKIE_MAX_AGE_SECONDS,
  cookieAttributes,
  isSecureRequest,
  isVisitorId,
  mintVisitorId,
  parseAssignments,
  serialiseAssignments,
} from "@/lib/experiments/cookies";

describe("mintVisitorId / isVisitorId", () => {
  it("mints a value it recognises", () => {
    expect(isVisitorId(mintVisitorId())).toBe(true);
  });

  it("mints a different id each time", () => {
    expect(mintVisitorId()).not.toBe(mintVisitorId());
  });

  it("rejects values this application did not mint", () => {
    for (const value of [
      "",
      "visitor-1",
      "00000000-0000-4000-8000-00000000000", // one digit short
      "00000000-0000-4000-8000-000000000000x",
      "not-a-uuid-at-all",
      // A value carrying the cookie's own separators would corrupt the
      // assignment cookie if it were ever echoed into one.
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|x:y",
    ]) {
      expect(isVisitorId(value)).toBe(false);
    }
  });

  it("accepts a well-formed uuid", () => {
    expect(isVisitorId("0189d0aa-4b27-4d1f-9c3e-2f7f8a1b2c3d")).toBe(true);
  });
});

describe("parseAssignments", () => {
  it("parses the documented format", () => {
    expect([...parseAssignments("a:one|b:two")]).toEqual([
      ["a", "one"],
      ["b", "two"],
    ]);
  });

  it("returns empty for absent or blank values", () => {
    expect(parseAssignments(undefined).size).toBe(0);
    expect(parseAssignments("").size).toBe(0);
  });

  it("drops malformed entries and keeps the rest", () => {
    // A cookie outlives deploys and is client-supplied; one unreadable entry
    // must not cost the reader the entries around it.
    expect([...parseAssignments("a:one|garbage|b:two|c:d:e|:x|y:")]).toEqual([
      ["a", "one"],
      ["b", "two"],
    ]);
  });

  it("drops entries whose ids are outside [a-z0-9-]", () => {
    expect(parseAssignments("Exp:one").size).toBe(0);
    expect(parseAssignments("exp:ONE").size).toBe(0);
    expect(parseAssignments("exp:with space").size).toBe(0);
  });

  it("keeps the first of a duplicated key", () => {
    // An appended duplicate must not displace an assignment already made.
    expect(parseAssignments("a:one|a:two").get("a")).toBe("one");
  });

  it("never throws on arbitrary input", () => {
    for (const value of ["|||", ":", "::::", "a".repeat(5_000)]) {
      expect(() => parseAssignments(value)).not.toThrow();
    }
  });
});

describe("serialiseAssignments", () => {
  it("round-trips through parseAssignments", () => {
    const entries: [string, string][] = [
      ["pricing-cta", "annual-first"],
      ["nav-order", "control"],
    ];
    expect([...parseAssignments(serialiseAssignments(entries))]).toEqual(
      entries,
    );
  });

  it("serialises nothing as the empty string", () => {
    expect(serialiseAssignments([])).toBe("");
  });

  it("preserves the order it is given", () => {
    expect(
      serialiseAssignments([
        ["b", "two"],
        ["a", "one"],
      ]),
    ).toBe("b:two|a:one");
  });
});

describe("cookieAttributes", () => {
  it("is httpOnly, lax, root-scoped and long-lived", () => {
    const attributes = cookieAttributes(true);
    expect(attributes.httpOnly).toBe(true);
    expect(attributes.sameSite).toBe("lax");
    expect(attributes.path).toBe("/");
    expect(attributes.maxAge).toBe(COOKIE_MAX_AGE_SECONDS);
  });

  it("is a year, so an experiment outlives a quarter", () => {
    expect(COOKIE_MAX_AGE_SECONDS).toBe(31_536_000);
  });

  it("follows the request's scheme for Secure", () => {
    // A `Secure` cookie over http://localhost is discarded silently, which
    // would make every local page view a new visitor.
    expect(cookieAttributes(false).secure).toBe(false);
    expect(cookieAttributes(true).secure).toBe(true);
  });
});

describe("isSecureRequest", () => {
  it("is true for an https URL", () => {
    expect(isSecureRequest(new URL("https://x.test/"), new Headers())).toBe(
      true,
    );
  });

  it("is false for http with no forwarding header", () => {
    expect(isSecureRequest(new URL("http://localhost/"), new Headers())).toBe(
      false,
    );
  });

  it("honours x-forwarded-proto from a terminating proxy", () => {
    expect(
      isSecureRequest(
        new URL("http://localhost/"),
        new Headers({ "x-forwarded-proto": "https" }),
      ),
    ).toBe(true);
  });

  it("reads the first entry of a chain", () => {
    expect(
      isSecureRequest(
        new URL("http://localhost/"),
        new Headers({ "x-forwarded-proto": "https, http" }),
      ),
    ).toBe(true);
  });

  it("is false for a forwarded scheme that is not https", () => {
    expect(
      isSecureRequest(
        new URL("http://localhost/"),
        new Headers({ "x-forwarded-proto": "http" }),
      ),
    ).toBe(false);
  });
});
