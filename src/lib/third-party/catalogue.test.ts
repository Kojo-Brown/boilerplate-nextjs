import { describe, expect, it } from "vitest";
import {
  PLAUSIBLE_ID,
  PLAUSIBLE_SCRIPT_SRC,
  THIRD_PARTIES,
  YOUTUBE_EMBED_ORIGIN,
  YOUTUBE_ID,
  findThirdParty,
  selectActiveScripts,
  selectPreconnectOrigins,
} from "./catalogue";

describe("the catalogue", () => {
  it("has no duplicate ids", () => {
    const ids = THIRD_PARTIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every entry at least one host", () => {
    for (const entry of THIRD_PARTIES) {
      expect(entry.hosts.length).toBeGreaterThan(0);
    }
  });

  it("gives every entry a reason someone can read", () => {
    // The `why` field is the only part of an entry no code consumes, which is
    // exactly why it needs a test: an inventory whose entries stop explaining
    // themselves is a list of hostnames.
    for (const entry of THIRD_PARTIES) {
      expect(entry.why.length).toBeGreaterThan(40);
    }
  });

  it("finds an entry by id and returns undefined for an unknown one", () => {
    expect(findThirdParty(PLAUSIBLE_ID)?.title).toBe("Plausible Analytics");
    expect(findThirdParty("not-a-vendor")).toBeUndefined();
  });

  it("loads the embedded player from the privacy-enhanced origin", () => {
    // youtube.com sets a cookie on load; youtube-nocookie.com does not until
    // playback begins. The facade means nothing is contacted at all before the
    // press, but the origin decides what the press then costs.
    expect(YOUTUBE_EMBED_ORIGIN).toBe("https://www.youtube-nocookie.com");
    expect(findThirdParty(YOUTUBE_ID)?.hosts).toContain(
      "www.youtube-nocookie.com",
    );
  });
});

describe("selectActiveScripts", () => {
  it("mounts nothing when analytics is not configured", () => {
    // The default for a fresh clone, for CI and for every preview deployment:
    // no configuration means no request leaves the browser for a vendor.
    expect(selectActiveScripts({})).toEqual([]);
    expect(selectActiveScripts({ plausibleDomain: undefined })).toEqual([]);
  });

  it("treats a blank domain as unset", () => {
    // `NEXT_PUBLIC_PLAUSIBLE_DOMAIN=` in a .env file sets the variable to the
    // empty string, which is present. Mounting on it would report every page
    // view under no site at all.
    expect(selectActiveScripts({ plausibleDomain: "" })).toEqual([]);
    expect(selectActiveScripts({ plausibleDomain: "   " })).toEqual([]);
  });

  it("mounts the analytics script with the strategy the catalogue declares", () => {
    const active = selectActiveScripts({ plausibleDomain: "app.example.com" });

    expect(active).toHaveLength(1);
    expect(active[0]?.src).toBe(PLAUSIBLE_SCRIPT_SRC);
    expect(active[0]?.strategy).toBe("afterInteractive");
    expect(active[0]?.attributes).toEqual({ "data-domain": "app.example.com" });
  });

  it("trims the configured domain", () => {
    const active = selectActiveScripts({
      plausibleDomain: " app.example.com ",
    });
    expect(active[0]?.attributes["data-domain"]).toBe("app.example.com");
  });

  it("never mounts a facade entry as a script", () => {
    const active = selectActiveScripts({ plausibleDomain: "app.example.com" });
    expect(active.map((script) => script.thirdParty.id)).not.toContain(
      YOUTUBE_ID,
    );
  });
});

describe("selectPreconnectOrigins", () => {
  it("warms the image CDN even with nothing else configured", () => {
    // The gallery's largest paint is an Unsplash URL, so the handshake is on
    // the critical path whether or not analytics exists.
    expect(selectPreconnectOrigins({})).toEqual([
      "https://images.unsplash.com",
    ]);
  });

  it("does not warm an analytics origin the deployment never contacts", () => {
    expect(selectPreconnectOrigins({})).not.toContain("https://plausible.io");
  });

  it("warms the analytics origin once it is configured", () => {
    expect(
      selectPreconnectOrigins({ plausibleDomain: "app.example.com" }),
    ).toEqual(["https://plausible.io", "https://images.unsplash.com"]);
  });

  it("never warms the facade's origin", () => {
    // The point of the facade: a reader who does not press play pays nothing,
    // and a preconnect would charge them a DNS lookup and a TLS handshake.
    // `scripts/assert-third-party-scripts.ts` fails the build on the catalogue
    // flag; this asserts the behaviour that flag is there to produce.
    const origins = selectPreconnectOrigins({
      plausibleDomain: "app.example.com",
    });
    expect(origins).not.toContain(YOUTUBE_EMBED_ORIGIN);
  });

  it("never warms a wildcard host, which has no origin to name", () => {
    const origins = selectPreconnectOrigins({
      plausibleDomain: "app.example.com",
    });
    expect(origins.some((origin) => origin.includes("*"))).toBe(false);
  });
});
