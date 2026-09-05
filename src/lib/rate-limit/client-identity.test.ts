import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRUSTED_PROXIES,
  UNIDENTIFIED_CLIENT,
  clientIdentity,
  normaliseAddress,
  selectForwardedEntry,
  trustedProxyCount,
} from "@/lib/rate-limit/client-identity";

describe("trustedProxyCount", () => {
  it("defaults when the variable is unset", () => {
    expect(trustedProxyCount(undefined)).toBe(DEFAULT_TRUSTED_PROXIES);
  });

  it("reads a positive integer", () => {
    expect(trustedProxyCount("3")).toBe(3);
  });

  it("falls back rather than refusing to boot over a bad value", () => {
    // A typo in a tuning knob should not stop the application starting; it
    // should count one hop, which is what almost every deployment has.
    for (const value of ["", "0", "-1", "two", "1.5", "NaN"]) {
      expect(trustedProxyCount(value)).toBe(DEFAULT_TRUSTED_PROXIES);
    }
  });
});

describe("selectForwardedEntry", () => {
  it("takes the entry the last trusted proxy wrote", () => {
    // One proxy: it appended the address it saw, which is the rightmost entry.
    expect(selectForwardedEntry("203.0.113.9", 1)).toBe("203.0.113.9");
    expect(selectForwardedEntry("198.51.100.7, 203.0.113.9", 1)).toBe(
      "203.0.113.9",
    );
  });

  it("counts back from the right for a longer trusted chain", () => {
    const chain = "198.51.100.7, 203.0.113.9, 10.0.0.1, 10.0.0.2";
    expect(selectForwardedEntry(chain, 2)).toBe("10.0.0.1");
    expect(selectForwardedEntry(chain, 3)).toBe("203.0.113.9");
  });

  it("ignores a client-supplied prefix", () => {
    // The bypass this whole module exists for: an attacker prepends whatever
    // they like, and `split(",")[0]` — the version in most examples — hands
    // them a fresh bucket per request.
    const spoofed = "1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.9";
    expect(selectForwardedEntry(spoofed, 1)).toBe("203.0.113.9");
  });

  it("falls back to the rightmost entry when the chain is shorter than claimed", () => {
    // Misconfiguration, or a request that skipped a proxy. The rightmost entry
    // is the only one an attacker could not have written, so it is the safe
    // answer; the leftmost would restore the bypass silently.
    expect(selectForwardedEntry("1.1.1.1, 203.0.113.9", 4)).toBe("203.0.113.9");
  });

  it("tolerates padding and empty entries", () => {
    expect(
      selectForwardedEntry("  , 198.51.100.7 ,  , 203.0.113.9 , ", 1),
    ).toBe("203.0.113.9");
  });

  it("has no answer for an empty header", () => {
    expect(selectForwardedEntry("", 1)).toBeUndefined();
    expect(selectForwardedEntry("  ,  ", 1)).toBeUndefined();
  });
});

describe("normaliseAddress", () => {
  it("keeps an IPv4 address whole", () => {
    expect(normaliseAddress("203.0.113.9")).toBe("203.0.113.9");
    expect(normaliseAddress(" 203.0.113.9 ")).toBe("203.0.113.9");
  });

  it("strips an IPv4 port", () => {
    expect(normaliseAddress("203.0.113.9:54321")).toBe("203.0.113.9");
  });

  it("strips a bracketed IPv6 port", () => {
    expect(normaliseAddress("[2001:db8::1]:443")).toBe("2001:db8:0:0::/64");
  });

  it("truncates IPv6 to its /64", () => {
    // One subscriber is routinely given a whole /64, so keying on the full
    // address lets a single machine mint 18 quintillion buckets.
    expect(normaliseAddress("2001:db8:85a3:1234:5678:8a2e:370:7334")).toBe(
      "2001:db8:85a3:1234::/64",
    );
  });

  it("puts every host of one /64 in the same bucket", () => {
    const first = normaliseAddress("2001:db8:85a3:1234::1");
    const second = normaliseAddress("2001:db8:85a3:1234:ffff:ffff:ffff:ffff");
    expect(first).toBe(second);
  });

  it("keeps neighbouring /64s apart", () => {
    expect(normaliseAddress("2001:db8:85a3:1234::1")).not.toBe(
      normaliseAddress("2001:db8:85a3:1235::1"),
    );
  });

  it("expands the compressed form correctly", () => {
    expect(normaliseAddress("::1")).toBe("0:0:0:0::/64");
    expect(normaliseAddress("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(normaliseAddress("fe80::1234:5678:9abc:def0")).toBe(
      "fe80:0:0:0::/64",
    );
  });

  it("reports an IPv4-mapped address as the IPv4 client it is", () => {
    // What a dual-stack listener reports for an IPv4 peer. Truncating it to a
    // /64 would collapse the entire IPv4 internet into one bucket, so one noisy
    // address would refuse everybody.
    expect(normaliseAddress("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(normaliseAddress("::ffff:cb00:7109")).toBe("203.0.113.9");
  });

  it("rejects anything that is not an address", () => {
    // Accepting arbitrary text would be the same bypass as spoofing, reached by
    // sending nonsense instead of a plausible address.
    for (const value of [
      "",
      "   ",
      "not-an-address",
      "999.1.1.1",
      "203.0.113",
      "2001:db8::1::2",
      "2001:db8:zzzz::1",
      "2001:db8:1:2:3:4:5:6:7",
      "<script>",
    ]) {
      expect(normaliseAddress(value)).toBeUndefined();
    }
  });
});

describe("clientIdentity", () => {
  const headers = (init: Record<string, string>) => new Headers(init);

  it("keys on the forwarded chain", () => {
    expect(
      clientIdentity(headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }), 1),
    ).toEqual({ key: "203.0.113.9", unidentified: false });
  });

  it("falls back to x-real-ip only when there is no chain", () => {
    expect(clientIdentity(headers({ "x-real-ip": "203.0.113.9" }), 1).key).toBe(
      "203.0.113.9",
    );

    // With a chain present, the header a client can add must never displace the
    // one our own infrastructure writes.
    expect(
      clientIdentity(
        headers({
          "x-forwarded-for": "198.51.100.7",
          "x-real-ip": "1.1.1.1",
        }),
        1,
      ).key,
    ).toBe("198.51.100.7");
  });

  it("shares one bucket when no address can be established", () => {
    expect(clientIdentity(headers({}), 1)).toEqual({
      key: UNIDENTIFIED_CLIENT,
      unidentified: true,
    });
    expect(
      clientIdentity(headers({ "x-forwarded-for": "garbage" }), 1).key,
    ).toBe(UNIDENTIFIED_CLIENT);
  });

  it("gives a spoofing client the same key every time", () => {
    // The end-to-end version of the property: a caller rotating the left of the
    // header still lands in one bucket, because the entry that counts was
    // written by our proxy.
    const keys = ["9.9.9.9", "8.8.8.8", "7.7.7.7"].map(
      (spoofed) =>
        clientIdentity(
          headers({ "x-forwarded-for": `${spoofed}, 203.0.113.9` }),
          1,
        ).key,
    );

    expect(new Set(keys).size).toBe(1);
  });
});
