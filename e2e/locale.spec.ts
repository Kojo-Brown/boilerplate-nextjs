import { test, expect } from "@playwright/test";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

/**
 * Locale routing is a browser behaviour, and the parts that matter most are the
 * ones no unit test can reach.
 *
 * `src/i18n/path.test.ts` proves the path arithmetic, `src/proxy.test.ts` proves
 * the composition, and `scripts/assert-route-shape.ts` proves both locales
 * prerendered. None of them answers the questions a visitor would ask: does the
 * page come back in the right language, does `<html dir>` actually make the
 * layout read right-to-left, does a click stay in the locale, and does the
 * choice survive a navigation. Those are a cookie, an attribute and a computed
 * style, and this is where they are asserted.
 */

test.describe("Locale routing", () => {
  // Public chrome; a session would only add noise. The locale cookie is what
  // these tests are about, so each one starts without one.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("serves the default locale at unprefixed paths", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    // Not a redirect: `as-needed` means `en` has no prefix, and a visitor who
    // was bounced to `/en` would be paying a round trip on every first visit.
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("serves the second locale under its prefix, right-to-left", async ({
    page,
  }) => {
    await page.goto("/ar");

    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });

  test("redirects the default locale's prefix to the canonical path", async ({
    page,
  }) => {
    // One URL per page. Two would split the cache and the analytics.
    await page.goto("/en/blog");

    expect(new URL(page.url()).pathname).toBe("/blog");
  });

  test("negotiates from Accept-Language when no cookie says otherwise", async ({
    browser,
  }) => {
    const context = await browser.newContext({ locale: "ar-EG" });
    const page = await context.newPage();

    await page.goto("/");

    expect(new URL(page.url()).pathname).toBe("/ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    await context.close();
  });

  test("remembers the locale in a cookie, so the header is read once", async ({
    page,
    context,
  }) => {
    await page.goto("/ar");

    const cookie = (await context.cookies()).find(
      (candidate) => candidate.name === "NEXT_LOCALE",
    );
    expect(cookie?.value).toBe("ar");
  });

  test("writes prefixed hrefs into the prerendered document", async ({
    page,
  }) => {
    // The defect this found, and the reason `experimental.rootParams` is on.
    // `next-intl`'s `requestLocale` is request-scoped, so during a prerender it
    // is `undefined` and the locale falls back to the default: `/ar` was
    // prerendered with `href="/blog"` on every link, and one click took an
    // Arabic visitor to the English document. Asserted on the attribute rather
    // than by clicking, because the href *is* the defect — a click would also
    // pass against a middleware redirect that quietly fixed it up at the cost
    // of a round trip.
    await page.goto("/ar");

    for (const path of ["/blog", "/photos", "/pricing", "/login"]) {
      await expect(
        page.locator(`a[href="/ar${path}"]`),
        `a link to ${path} on /ar should point at /ar${path}`,
      ).not.toHaveCount(0);
      await expect(page.locator(`a[href="${path}"]`)).toHaveCount(0);
    }
  });

  test("stays in the locale across a navigation", async ({ page }) => {
    await page.goto("/ar");
    await page.locator('a[href="/ar/blog"]').first().click();
    await page.waitForURL("**/ar/blog");

    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });

  test("404s an unknown first segment instead of serving the default locale", async ({
    page,
  }) => {
    // `[locale]` is a dynamic segment at the root of the tree, so it catches
    // everything — and `next-intl`'s request config falls back to the default
    // locale, which means without the layout's `isLocale` check this URL would
    // render a complete, plausible, 200-answering landing page.
    const response = await page.goto("/not-a-locale");

    expect(response?.status()).toBe(404);
  });

  test("leaves route handlers outside the segment", async ({ page }) => {
    // `/api/*` is not under `src/app/[locale]`. If locale negotiation touched
    // it, an Arabic visitor's every `fetch` would 404.
    await page.goto("/ar");

    const response = await page.request.get("/api/health");
    expect(response.status()).toBe(200);
    expect(new URL(response.url()).pathname).toBe("/api/health");
  });
});

test.describe("The RTL pass", () => {
  // Public chrome, deliberately. The sidebar only exists on the dashboard, and
  // reaching that needs the registration fixture — which cannot run against a
  // database with row-level security on, because `tenants` has no INSERT policy
  // by design (see docs/multi-tenancy.md). Both claims below are made on the
  // two things every page carries instead: the skip link, whose position is
  // `inset-inline-start`, and the theme control, whose label comes from the
  // catalogue.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("mirrors the skip link, which is positioned with a logical property", async ({
    page,
  }) => {
    // The claim `scripts/assert-logical-properties.ts` cannot make. It checks
    // that the class names are logical — `focus:start-2`, not `focus:left-2` —
    // and `ms-4` and `ml-4` render identically in English, which is the whole
    // reason that gate exists. Only a browser can say the resulting layout
    // actually mirrors, and only an RTL locale can show it.
    //
    // The skip link is measured while focused because that is the only state in
    // which it is positioned at all: it is off-screen until then.
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto("/");
    await page.keyboard.press("Tab");
    const ltr = await page.locator('a[href="#main-content"]').boundingBox();

    await page.goto("/ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.keyboard.press("Tab");
    const rtl = await page.locator('a[href="#main-content"]').boundingBox();

    expect(ltr).not.toBeNull();
    expect(rtl).not.toBeNull();
    // Left edge in `en`, right edge in `ar`.
    expect(ltr!.x).toBeLessThan(640);
    expect(rtl!.x).toBeGreaterThan(640);
  });

  test("renders chrome from the active locale's catalogue", async ({
    page,
  }) => {
    // The theme control and the skip link are the two strings on every page
    // that come from the catalogues, so they are the ones that say whether a
    // document was rendered in its own language rather than in the default.
    await page.goto("/ar");

    await expect(
      page.getByRole("button", { name: ar.common.theme.system }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: ar.common.skipToContent }),
    ).toBeAttached();

    // And not the English strings, which is what a document that fell back to
    // the default locale would still be carrying — the `requestLocale`
    // regression this file found, seen from the other side.
    await expect(
      page.getByRole("button", { name: en.common.theme.system }),
    ).toHaveCount(0);
  });
});
