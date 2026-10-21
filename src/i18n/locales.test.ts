import { describe, it, expect } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALES,
  isLocale,
  textDirection,
} from "@/i18n/locales";

describe("LOCALES", () => {
  it("contains the default locale", () => {
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });

  it("has no duplicates", () => {
    expect(new Set(LOCALES).size).toBe(LOCALES.length);
  });

  it("names every locale with a tag `Intl` understands", () => {
    // A tag `Intl` cannot resolve would silently fall back to the runtime's
    // default locale for plural selection and number formatting, which is how
    // a typo in this list turns into a page that formats as English.
    for (const locale of LOCALES) {
      expect(Intl.PluralRules.supportedLocalesOf([locale]), locale).toEqual([
        locale,
      ]);
    }
  });

  it("ships at least one right-to-left locale", () => {
    // The RTL pass is only meaningful while something exercises it: with an
    // all-LTR locale list, `scripts/assert-logical-properties.ts` guards a
    // property no page depends on, and the next physical utility to be added
    // looks correct in every locale that exists.
    expect(LOCALES.some((locale) => textDirection(locale) === "rtl")).toBe(
      true,
    );
  });
});

describe("isLocale", () => {
  it("accepts every declared locale", () => {
    for (const locale of LOCALES) {
      expect(isLocale(locale), locale).toBe(true);
    }
  });

  it("rejects an undeclared tag", () => {
    expect(isLocale("de")).toBe(false);
  });

  it("rejects a tag that differs only by case", () => {
    // Locale tags are matched exactly against the catalogue filenames. `AR`
    // would resolve no catalogue, so accepting it here would move the failure
    // from this guard to a page full of key paths.
    expect(isLocale("AR")).toBe(false);
  });

  it("rejects values that are not strings", () => {
    for (const value of [undefined, null, 0, {}, [], ["en"]]) {
      expect(isLocale(value), String(value)).toBe(false);
    }
  });
});

describe("textDirection", () => {
  it("reads English left-to-right", () => {
    expect(textDirection("en")).toBe("ltr");
  });

  it("reads Arabic right-to-left", () => {
    expect(textDirection("ar")).toBe("rtl");
  });

  it("answers for every declared locale", () => {
    // `TEXT_DIRECTIONS` is checked by the compiler, but only against the
    // locales that existed when it was written. This fails on a locale added
    // to `LOCALES` whose direction was left to an index signature or a cast.
    for (const locale of LOCALES) {
      expect(["ltr", "rtl"], locale).toContain(textDirection(locale));
    }
  });
});
