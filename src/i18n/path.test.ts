import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, LOCALES } from "@/i18n/locales";
import { internalPath, localisePath, splitLocalePath } from "@/i18n/path";

describe("splitLocalePath", () => {
  it("strips a prefixed locale and keeps the rest of the path", () => {
    expect(splitLocalePath("/ar/dashboard")).toEqual({
      locale: "ar",
      pathname: "/dashboard",
    });
  });

  it("leaves an unprefixed path alone", () => {
    expect(splitLocalePath("/dashboard")).toEqual({
      locale: null,
      pathname: "/dashboard",
    });
  });

  it("gives a locale root the path `/` rather than the empty string", () => {
    // `""` starts with no prefix in any list, so `startsWith` is false for
    // everything against it — a locale root that answers "not protected" to
    // every question the session gate asks.
    expect(splitLocalePath("/ar")).toEqual({ locale: "ar", pathname: "/" });
    expect(splitLocalePath("/ar/")).toEqual({ locale: "ar", pathname: "/" });
  });

  it("compares the whole first segment, not a prefix of it", () => {
    // `/arabic` begins with the two characters of `ar` and is not an `ar` path.
    // A `startsWith("/ar")` test would have returned `/abic` here.
    expect(splitLocalePath("/arabic")).toEqual({
      locale: null,
      pathname: "/arabic",
    });
    expect(splitLocalePath("/article/1")).toEqual({
      locale: null,
      pathname: "/article/1",
    });
  });

  it("does not read an empty first segment as a locale", () => {
    // `//evil.example` is a protocol-relative URL that reaches the proxy as a
    // pathname. Its first segment is `""`; treating that as a locale would hand
    // the authority back as the path.
    expect(splitLocalePath("//evil.example")).toEqual({
      locale: null,
      pathname: "//evil.example",
    });
  });

  it("recognises the default locale's prefix even though it is never served", () => {
    // `/en/dashboard` is redirected to `/dashboard` by next-intl's middleware,
    // but the session gate runs first. Declining to recognise the prefix here
    // would make the ordering of two middlewares a security property.
    expect(splitLocalePath("/en/admin")).toEqual({
      locale: "en",
      pathname: "/admin",
    });
  });

  it("round-trips every locale through localisePath", () => {
    for (const locale of LOCALES) {
      const localised = localisePath(locale, "/dashboard");
      expect(splitLocalePath(localised).pathname).toBe("/dashboard");
    }
  });
});

describe("localisePath", () => {
  it("leaves the default locale unprefixed", () => {
    // `as-needed`: `/en/login` is answered with a redirect to `/login`, so
    // prefixing here would make every anonymous refusal a redirect to a
    // redirect.
    expect(localisePath(DEFAULT_LOCALE, "/login")).toBe("/login");
    expect(localisePath(DEFAULT_LOCALE, "/")).toBe("/");
  });

  it("prefixes every other locale", () => {
    expect(localisePath("ar", "/login")).toBe("/ar/login");
  });

  it("gives the root no trailing slash", () => {
    // `/ar/` and `/ar` are the same page, and only one of them is canonical.
    expect(localisePath("ar", "/")).toBe("/ar");
  });
});

describe("internalPath", () => {
  it("prefixes the default locale too, unlike localisePath", () => {
    // The distinction the two functions exist for. `/pricing` is the URL `en`
    // is served at; `/en/pricing` is the segment path that answers it. A
    // rewrite to the first 404s, because `src/app/pricing` no longer exists.
    expect(internalPath(DEFAULT_LOCALE, "/pricing")).toBe("/en/pricing");
    expect(localisePath(DEFAULT_LOCALE, "/pricing")).toBe("/pricing");
  });

  it("prefixes every other locale the same way", () => {
    expect(internalPath("ar", "/pricing")).toBe("/ar/pricing");
  });

  it("maps the root onto the bare locale segment", () => {
    expect(internalPath("en", "/")).toBe("/en");
    expect(internalPath("ar", "/")).toBe("/ar");
  });

  it("round-trips through splitLocalePath for every locale", () => {
    for (const locale of LOCALES) {
      expect(splitLocalePath(internalPath(locale, "/pricing"))).toEqual({
        locale,
        pathname: "/pricing",
      });
    }
  });
});
