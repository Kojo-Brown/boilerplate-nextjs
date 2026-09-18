import { describe, it, expect } from "vitest";
import {
  FORWARDED_GEO_HEADER,
  UNKNOWN_COUNTRY,
  normaliseCountry,
  readGeo,
  targetsCountry,
  trustsForwardedGeo,
} from "@/lib/experiments/geo";

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe("normaliseCountry", () => {
  it("uppercases and trims", () => {
    expect(normaliseCountry(" gb ")).toBe("GB");
  });

  it("rejects anything that is not two letters", () => {
    expect(normaliseCountry("USA")).toBeUndefined();
    expect(normaliseCountry("U")).toBeUndefined();
    expect(normaliseCountry("United States")).toBeUndefined();
    expect(normaliseCountry("12")).toBeUndefined();
    expect(normaliseCountry("")).toBeUndefined();
  });

  it("rejects the codes that mean 'unknown'", () => {
    // Cloudflare's own sentinels. They match /^[A-Z]{2}$/ and would otherwise
    // be compared against a targeting list as if they were countries.
    expect(normaliseCountry("XX")).toBeUndefined();
    expect(normaliseCountry("T1")).toBeUndefined();
    expect(normaliseCountry("ZZ")).toBeUndefined();
  });
});

describe("readGeo — trusted platform headers", () => {
  it("reads x-vercel-ip-country", () => {
    expect(readGeo(headers({ "x-vercel-ip-country": "de" }))).toEqual({
      country: "DE",
      source: "x-vercel-ip-country",
    });
  });

  it("reads cf-ipcountry", () => {
    expect(readGeo(headers({ "cf-ipcountry": "FR" }))).toEqual({
      country: "FR",
      source: "cf-ipcountry",
    });
  });

  it("prefers the innermost proxy when both are present", () => {
    // Cloudflare in front of Vercel: Vercel's header was written last, by the
    // hop closest to this process, so it is the one that cannot have been
    // forged by the layer outside it.
    expect(
      readGeo(headers({ "cf-ipcountry": "FR", "x-vercel-ip-country": "DE" }))
        .country,
    ).toBe("DE");
  });

  it("falls through to the next header when the first is unusable", () => {
    expect(
      readGeo(headers({ "x-vercel-ip-country": "XX", "cf-ipcountry": "CA" })),
    ).toEqual({ country: "CA", source: "cf-ipcountry" });
  });

  it("reports unknown when nothing usable arrived", () => {
    expect(readGeo(new Headers())).toEqual({
      country: UNKNOWN_COUNTRY,
      source: "none",
    });
  });
});

describe("readGeo — the forwarded header", () => {
  it("ignores it by default", () => {
    // The whole point: nothing strips `x-geo-country`, so a browser can send
    // one. Reading it without an opt-in would let any caller pick their market.
    expect(readGeo(headers({ [FORWARDED_GEO_HEADER]: "US" })).country).toBe(
      UNKNOWN_COUNTRY,
    );
  });

  it("reads it when the deployment opts in", () => {
    expect(
      readGeo(headers({ [FORWARDED_GEO_HEADER]: "US" }), {
        trustForwarded: true,
      }),
    ).toEqual({ country: "US", source: "forwarded" });
  });

  it("never outranks a platform header", () => {
    expect(
      readGeo(headers({ [FORWARDED_GEO_HEADER]: "US", "cf-ipcountry": "JP" }), {
        trustForwarded: true,
      }).country,
    ).toBe("JP");
  });
});

describe("trustsForwardedGeo", () => {
  it("is on for 1 and true", () => {
    expect(trustsForwardedGeo("1")).toBe(true);
    expect(trustsForwardedGeo("true")).toBe(true);
  });

  it("is off for everything else, including near-misses", () => {
    for (const value of [undefined, "", "0", "false", "no", "TRUE", "yes"]) {
      expect(trustsForwardedGeo(value)).toBe(false);
    }
  });
});

describe("targetsCountry", () => {
  it("treats an omitted list as everywhere", () => {
    expect(targetsCountry(undefined, "DE")).toBe(true);
    expect(targetsCountry(undefined, UNKNOWN_COUNTRY)).toBe(true);
  });

  it("matches a listed country", () => {
    expect(targetsCountry(["US", "CA"], "CA")).toBe(true);
  });

  it("excludes an unlisted country", () => {
    expect(targetsCountry(["US", "CA"], "DE")).toBe(false);
  });

  it("excludes unknown traffic from a targeted experiment", () => {
    expect(targetsCountry(["US"], UNKNOWN_COUNTRY)).toBe(false);
  });
});
