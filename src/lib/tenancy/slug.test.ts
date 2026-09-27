import { describe, it, expect } from "vitest";

import {
  MAX_SLUG_LENGTH,
  MIN_SLUG_LENGTH,
  RESERVED_SLUGS,
  describeSlugProblem,
  isValidSlug,
  slugProblem,
  slugify,
} from "./slug";

describe("slugProblem", () => {
  it("accepts a plain lowercase name", () => {
    expect(slugProblem("acme")).toBeNull();
    expect(slugProblem("acme-corp")).toBeNull();
    expect(slugProblem("acme2")).toBeNull();
  });

  it("refuses a name shorter than the minimum", () => {
    expect(slugProblem("a")).toBe("too-short");
    expect(slugProblem("")).toBe("too-short");
  });

  it("refuses a name longer than a DNS label", () => {
    // The bound is not arbitrary: a slug is meant to be usable as a subdomain,
    // and a label over 63 octets is rejected by DNS itself.
    expect(slugProblem("a".repeat(MAX_SLUG_LENGTH))).toBeNull();
    expect(slugProblem("a".repeat(MAX_SLUG_LENGTH + 1))).toBe("too-long");
  });

  it("refuses uppercase, so one tenant cannot shadow another by case", () => {
    // Hostnames are case-insensitive. Allowing `Acme` alongside `acme` would
    // make two rows that are one tenant to a browser and two to the unique
    // index — which is the index failing to do the one thing it is for.
    expect(slugProblem("Acme")).toBe("malformed");
  });

  it.each([
    ["a leading hyphen", "-acme"],
    ["a trailing hyphen", "acme-"],
    ["an underscore", "acme_corp"],
    ["a dot", "acme.corp"],
    ["a space", "acme corp"],
    ["a slash, which would forge a path segment", "acme/admin"],
    ["a percent escape", "acme%2f"],
  ])("refuses %s", (_name, slug) => {
    expect(slugProblem(slug)).toBe("malformed");
  });

  it("refuses the names the deployment already answers to", () => {
    // With subdomain routing these are not merely confusing: `admin` is a
    // phishing surface this application's own links would lend credibility to.
    expect(slugProblem("admin")).toBe("reserved");
    expect(slugProblem("www")).toBe("reserved");
    expect(slugProblem("api")).toBe("reserved");
  });

  it("checks the grammar before the reserved list", () => {
    // Otherwise a reserved word in the wrong case reports "reserved", which
    // tells somebody to pick a different name when the name was fine.
    expect(slugProblem("ADMIN")).toBe("malformed");
  });

  it("holds every reserved name to the grammar it is reserved against", () => {
    // A reserved entry that is not itself a legal slug can never be matched,
    // so it protects nothing while looking as though it does.
    for (const reserved of RESERVED_SLUGS) {
      expect(reserved.length).toBeGreaterThanOrEqual(MIN_SLUG_LENGTH);
      expect(reserved).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    }
  });
});

describe("isValidSlug", () => {
  it("is the boolean form of the same rule", () => {
    expect(isValidSlug("acme")).toBe(true);
    expect(isValidSlug("admin")).toBe(false);
  });
});

describe("describeSlugProblem", () => {
  it("has a sentence for every reason", () => {
    // `slugProblem`'s union and this switch are written in two places, so a
    // new reason with no sentence is the drift worth catching.
    for (const problem of [
      "too-short",
      "too-long",
      "malformed",
      "reserved",
    ] as const) {
      expect(describeSlugProblem(problem)).toMatch(/\S/);
    }
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates a name", () => {
    expect(slugify("Acme Corp")).toBe("acme-corp");
  });

  it("strips accents rather than dropping the letters under them", () => {
    // The behaviour a person expects from a name they typed. A transliteration
    // table would be better and is a great deal more than this needs.
    expect(slugify("Zoë's Café")).toBe("zoes-cafe");
  });

  it("removes an apostrophe instead of splitting the word on it", () => {
    // `provisionPersonalTenant` names every personal workspace "<Name>'s
    // workspace", so the general "punctuation becomes a hyphen" rule would
    // make `ada-s-workspace` the default slug for every new account.
    expect(slugify("Ada's workspace")).toBe("adas-workspace");
    // The typographic apostrophe too, which is what a phone keyboard sends.
    expect(slugify("Ada’s workspace")).toBe("adas-workspace");
  });

  it("collapses runs of punctuation into one hyphen", () => {
    expect(slugify("Acme  ---  Corp!!")).toBe("acme-corp");
  });

  it("trims hyphens from both ends", () => {
    expect(slugify("  Acme  ")).toBe("acme");
    expect(slugify("!Acme!")).toBe("acme");
  });

  it("truncates to the maximum length without leaving a trailing hyphen", () => {
    // The slice can cut mid-word and leave a hyphen that was legal before it,
    // which would make the result fail the grammar this function feeds.
    const name = `${"a".repeat(MAX_SLUG_LENGTH - 1)} bbbb`;
    const slug = slugify(name);

    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
    expect(isValidSlug(slug)).toBe(true);
  });

  it("returns something invalid rather than throwing, for a name with no Latin form", () => {
    // Documented behaviour, not an oversight: the caller checks the result,
    // because it has to check user input anyway. `provisionTenant` falls back
    // to an id-derived slug when this happens.
    expect(slugify("日本語")).toBe("");
    expect(isValidSlug(slugify("日本語"))).toBe(false);
  });

  it("can produce a reserved word, which is why its output is checked", () => {
    expect(slugify("Admin")).toBe("admin");
    expect(isValidSlug(slugify("Admin"))).toBe(false);
  });
});
