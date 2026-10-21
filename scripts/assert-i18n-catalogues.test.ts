import { describe, it, expect } from "vitest";
import {
  checkCatalogues,
  declaredCategories,
  flattenKeys,
  formatViolations,
  messageAt,
  readCatalogue,
  representativeFor,
  requiredCategories,
  type Catalogue,
} from "./assert-i18n-catalogues";
import { DEFAULT_LOCALE, LOCALES } from "../src/i18n/locales";

/** A minimal well-formed pair, used as the base for the broken variants. */
const EN: Catalogue = {
  nav: { posts: "Posts" },
  posts: {
    count: "{count, plural, =0 {No posts yet} one {# post} other {# posts}}",
  },
};

const AR: Catalogue = {
  nav: { posts: "المنشورات" },
  posts: {
    count:
      "{count, plural, zero {لا توجد منشورات} one {منشور واحد} two {منشوران} few {# منشورات} many {# منشورًا} other {# منشور}}",
  },
};

describe("flattenKeys", () => {
  it("returns dotted leaf paths, sorted", () => {
    expect(flattenKeys({ b: "1", a: { d: "2", c: "3" } })).toEqual([
      "a.c",
      "a.d",
      "b",
    ]);
  });

  it("is empty for an empty catalogue", () => {
    expect(flattenKeys({})).toEqual([]);
  });

  it("does not treat a namespace as a leaf", () => {
    expect(flattenKeys({ theme: { light: "Light" } })).toEqual(["theme.light"]);
  });
});

describe("messageAt", () => {
  it("resolves a nested path", () => {
    expect(messageAt(EN, "nav.posts")).toBe("Posts");
  });

  it("is undefined for a missing path", () => {
    expect(messageAt(EN, "nav.missing")).toBeUndefined();
  });

  it("is undefined for a path that lands on a namespace", () => {
    // A namespace is not a message. Returning the object here would make the
    // plural checks below run `.test()` against "[object Object]".
    expect(messageAt(EN, "nav")).toBeUndefined();
  });

  it("is undefined when a path runs through a string", () => {
    expect(messageAt(EN, "nav.posts.deeper")).toBeUndefined();
  });
});

describe("requiredCategories", () => {
  it("gives English two cardinal categories", () => {
    expect(requiredCategories("en")).toEqual(["one", "other"]);
  });

  it("gives Arabic all six, in CLDR order", () => {
    expect(requiredCategories("ar")).toEqual([
      "zero",
      "one",
      "two",
      "few",
      "many",
      "other",
    ]);
  });

  it("reads ordinal rules when asked for them", () => {
    // English ordinals are 1st/2nd/3rd/4th — four categories, against two for
    // cardinals. A gate that used cardinal rules for `selectordinal` would
    // accept a two-branch ordinal message.
    expect(requiredCategories("en", "ordinal")).toEqual([
      "one",
      "two",
      "few",
      "other",
    ]);
  });
});

describe("declaredCategories", () => {
  it("finds the branches of a plural message", () => {
    const message = messageAt(AR, "posts.count");
    expect(message).toBeDefined();
    expect([...declaredCategories(message as string)].sort()).toEqual([
      "few",
      "many",
      "one",
      "other",
      "two",
      "zero",
    ]);
  });

  it("requires the brace, so a bare keyword is not mistaken for a branch", () => {
    // "one" and "other" both appear as words; neither is followed by `{`.
    expect([...declaredCategories("Pick one, then the other of two")]).toEqual(
      [],
    );
  });

  it("over-reports prose that happens to read `<keyword> {`", () => {
    // The documented limit of scanning rather than parsing: here "other" is
    // prose immediately before an argument, and it is counted as a branch.
    //
    // This is the safe direction to be wrong in, and it is why the category
    // check is not the only plural check. Counting a branch that does not
    // exist can only make `checkCatalogues` *accept* a message it should have
    // questioned — it can never fail a correct catalogue. The format pass over
    // every required category then has to succeed regardless of what this scan
    // believed, so a message misread here still has to produce output for each
    // of its locale's categories.
    expect([...declaredCategories("Pick one, then the other {count}")]).toEqual(
      ["other"],
    );
  });

  it("tolerates whitespace between the keyword and its brace", () => {
    expect([
      ...declaredCategories("{n, plural, one\n  {#} other {#}}"),
    ]).toEqual(["one", "other"]);
  });
});

describe("representativeFor", () => {
  it("finds a number for each Arabic category", () => {
    for (const category of requiredCategories("ar")) {
      const count = representativeFor("ar", category);
      expect(count, `no representative for ${category}`).toBeDefined();
      expect(new Intl.PluralRules("ar").select(count as number)).toBe(category);
    }
  });

  it("finds 1 for English `one`", () => {
    expect(representativeFor("en", "one")).toBe(1);
  });

  it("is undefined for a category the locale does not have", () => {
    expect(representativeFor("en", "two")).toBeUndefined();
  });
});

describe("checkCatalogues", () => {
  it("passes a complete, correctly pluralised pair", () => {
    expect(checkCatalogues({ en: EN, ar: AR })).toEqual([]);
  });

  it("reports a key the default catalogue has and a locale does not", () => {
    const violations = checkCatalogues({
      en: EN,
      ar: { nav: { posts: "المنشورات" } },
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      locale: "ar",
      key: "posts.count",
      problem: "missing",
    });
  });

  it("reports a key a locale has and the default catalogue does not", () => {
    const violations = checkCatalogues({
      en: EN,
      ar: { ...AR, extra: "زائد" },
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      locale: "ar",
      key: "extra",
      problem: "not in the default catalogue",
    });
  });

  it("reports a plural that was flattened to a bare string", () => {
    const violations = checkCatalogues({
      en: EN,
      ar: { ...AR, posts: { count: "# منشورات" } },
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("is not a `plural` message");
  });

  it("reports an Arabic plural carrying English's two branches", () => {
    // The defect this gate exists for: well-formed ICU, formats without error,
    // and grammatically wrong for 2, 3 and 11.
    const violations = checkCatalogues({
      en: EN,
      ar: {
        ...AR,
        posts: { count: "{count, plural, one {# منشور} other {# منشورات}}" },
      },
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toBe(
      "declares no `zero`, `two`, `few`, `many` branch",
    );
  });

  it("reports a message that parses as a plural but fails to format", () => {
    // Every branch is declared, so the category check is satisfied; the message
    // is still broken, and only formatting it finds that out.
    const truncated = (AR.posts as Catalogue).count as string;
    const violations = checkCatalogues({
      en: EN,
      ar: { ...AR, posts: { count: truncated.slice(0, -1) } },
    });

    expect(violations.length).toBeGreaterThan(0);
    expect(
      violations.every((violation) => violation.key === "posts.count"),
    ).toBe(true);
    expect(violations.some((v) => v.problem.includes("fails to format"))).toBe(
      true,
    );
  });

  it("reports a missing default catalogue once and stops", () => {
    const violations = checkCatalogues({ ar: AR });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("no catalogue for the default");
  });

  it("reports a missing non-default catalogue", () => {
    const violations = checkCatalogues({ en: EN });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      locale: "ar",
      problem: "`messages/ar.json` is missing",
    });
  });

  it("does not require plural branches of a message that is not a plural", () => {
    expect(
      checkCatalogues({
        en: { greeting: "Hello {name}" },
        ar: { greeting: "مرحبًا {name}" },
      }),
    ).toEqual([]);
  });
});

describe("formatViolations", () => {
  it("numbers each line and names the locale", () => {
    expect(
      formatViolations([
        { locale: "ar", key: "posts.count", problem: "missing", because: "x" },
      ]),
    ).toBe("  1. [ar] posts.count — missing");
  });
});

describe("the catalogues this repository ships", () => {
  it("are complete and correctly pluralised", () => {
    // The same assertion the build job makes, run in the unit suite so a bad
    // translation fails in seconds rather than after a full build.
    const catalogues = Object.fromEntries(
      LOCALES.map((locale) => [locale, readCatalogue("messages", locale)]),
    );

    expect(checkCatalogues(catalogues)).toEqual([]);
  });

  it("has a readable catalogue for every declared locale", () => {
    for (const locale of LOCALES) {
      expect(readCatalogue("messages", locale), locale).toBeDefined();
    }
  });

  it("returns undefined for a locale with no file", () => {
    expect(
      readCatalogue("messages", "zz" as (typeof LOCALES)[number]),
    ).toBeUndefined();
  });

  it("uses the default locale as the reference", () => {
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });
});
