import { test, expect, type Page } from "@playwright/test";

/**
 * Focus is a browser behaviour, and it is the half of this feature the unit
 * suite cannot observe.
 *
 * `route-focus.test.tsx` proves the policy fires on the right navigations and
 * `assert-focus-management.ts` proves every document has a landmark with a
 * `tabindex` on it. Neither proves the thing a keyboard user cares about:
 * that following the skip link actually moves the focus rather than the
 * viewport, that the next Tab lands inside the content, that Back returns to
 * the tile that opened a modal, and that Next's own route announcer is still
 * speaking the destination. The first of those is a fragment navigation, which
 * jsdom does not implement at all; the last is a shadow root.
 *
 * Not run by CI — there is no end-to-end job in `.github/workflows/ci.yml`, by
 * the same reasoning as the other twelve specs here. Run it with
 * `pnpm build && pnpm test:e2e focus-management`.
 */

// All of this is public chrome; a session would only add noise.
test.use({ storageState: { cookies: [], origins: [] } });

const skipLink = (page: Page) =>
  page.getByRole("link", { name: "Skip to main content" });

/**
 * Wait until the client has taken over.
 *
 * Before hydration a click on a `<Link>` is an ordinary browser navigation —
 * a full page load, which focuses the document itself and correctly does not
 * run any of this. Three of these tests passed for the wrong reason until
 * this existed, and one failed for it. Next's route announcer is appended to
 * `<body>` from an effect, so its presence is the hydration signal and needs
 * nothing added to the application to observe.
 */
async function hydrated(page: Page): Promise<void> {
  await page.waitForSelector("next-route-announcer", { state: "attached" });
}

/** What `document.activeElement` is, named the way a human would name it. */
async function activeElementDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active) return "none";
    const id = active.id ? `#${active.id}` : "";
    return `${active.tagName.toLowerCase()}${id}`;
  });
}

test.describe("Skip link", () => {
  test("is the first thing Tab reaches, and is visible once it has focus", async ({
    page,
  }) => {
    await page.goto("/photos");
    await page.keyboard.press("Tab");

    // Visible, not just focused: a skip link that stays `sr-only` when focused
    // leaves a sighted keyboard user watching focus disappear for one Tab.
    await expect(skipLink(page)).toBeFocused();
    await expect(skipLink(page)).toBeVisible();
  });

  test("moves the focus and not only the viewport", async ({ page }) => {
    await page.goto("/photos");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");

    // The assertion the whole feature turns on. Without `tabindex="-1"` on
    // `<main>` this passes the eye test — the page scrolls to the content —
    // and `activeElement` is `body`, so the next Tab goes back to the header.
    expect(await activeElementDescription(page)).toBe("main#main-content");
  });

  test("leaves the next Tab inside the content", async ({ page }) => {
    await page.goto("/photos");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");

    const focused = page.locator(":focus");
    await expect(focused).toHaveCount(1);
    expect(
      await focused.evaluate(
        (element) => element.closest("#main-content") !== null,
      ),
    ).toBe(true);
  });
});

test.describe("Focus across client-side navigations", () => {
  test("a client-side navigation moves focus to the landmark", async ({
    page,
  }) => {
    await page.goto("/");
    await hydrated(page);
    await page.getByRole("link", { name: /^Blog/ }).click();
    await expect(page).toHaveURL(/\/blog$/);

    // The defect this fixes: without it, focus is still on the link that was
    // activated — which on a route with persistent chrome is in the sidebar,
    // so the next Tab continues from the middle of the old page's nav.
    await expect
      .poll(() => activeElementDescription(page))
      .toBe("main#main-content");
  });

  test("does not steal focus on the first load", async ({ page }) => {
    await page.goto("/blog");

    // A full page load already focuses the document and the screen reader is
    // reading what was asked for; moving the cursor here skips the heading.
    await expect.poll(() => activeElementDescription(page)).toBe("body");
  });

  test("Next's route announcer speaks the destination", async ({ page }) => {
    // This application deliberately adds no live region of its own: Next's
    // `AppRouterAnnouncer` already renders one (`role="alert"`, in a shadow
    // root on `<next-route-announcer>`) and announces the document title on
    // every client navigation. A second region would mean every route change
    // is spoken twice. That makes it a dependency worth pinning — if a future
    // Next release drops it, this test fails and the announcement becomes
    // ours to own. See docs/focus-management.md.
    await page.goto("/");
    await hydrated(page);
    await page.getByRole("link", { name: /^Blog/ }).click();
    await expect(page).toHaveURL(/\/blog$/);

    await expect
      .poll(() =>
        page.evaluate(() => {
          const announcer = document
            .querySelector("next-route-announcer")
            ?.shadowRoot?.querySelector("#__next-route-announcer__");
          return announcer?.textContent ?? null;
        }),
      )
      .toContain("Blog");
  });
});

test.describe("Focus and the intercepted modal route", () => {
  test("opening a photo focuses the dialog, not the gallery behind it", async ({
    page,
  }) => {
    await page.goto("/photos");
    await hydrated(page);
    await page.getByRole("link", { name: /ocean at sunset/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Both components have a correct reason to move focus on this navigation.
    // The dialog's claim is what decides it; without the claim the router's
    // manager puts focus on the gallery, behind an `aria-modal` overlay.
    await expect(page.getByRole("dialog")).toBeFocused();
  });

  test("dismissing the modal returns focus to the tile that opened it", async ({
    page,
  }) => {
    await page.goto("/photos");
    await hydrated(page);

    // Opened from the keyboard, which is the case restoration exists for and
    // the case it can serve: the tile is remembered because it was focused.
    // A mouse user who clicks the same tile gets the landmark instead, and
    // has no cursor to lose.
    const tile = page.getByRole("link", { name: /ocean at sunset/i });
    await tile.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The gallery was never unmounted — it is the page under a parallel route
    // slot — so the tile is the same DOM node and focus can go back to it.
    // Landing on `<main>` instead would be the "where was I?" experience that
    // makes keyboard users avoid modals.
    await expect(tile).toBeFocused();
  });
});

test.describe("Back", () => {
  // Short viewport on purpose: at the default 720px every page in this
  // application fits and `window.scrollY` is 0 throughout, so an assertion
  // about scrolling holds whatever the code does.
  test.use({ viewport: { width: 1280, height: 320 } });

  test("leaves focus on the landmark and the scroll where the router put it", async ({
    page,
  }) => {
    await page.goto("/blog");
    await hydrated(page);
    await page.evaluate(() => window.scrollTo(0, 200));
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);

    await page.getByRole("link", { name: /Home/ }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/blog$/);

    // Focus lands on the rebuilt landmark rather than being left on <body>.
    // It is not restored to the link that was clicked: that node belongs to
    // the outgoing render, which Next keeps mounted and hidden so Back can be
    // instant — connected, invisible, and unfocusable. `focus-memory.ts`
    // declines it and the landmark is the fallback.
    await expect
      .poll(() => activeElementDescription(page))
      .toBe("main#main-content");

    // Next does not restore the scroll offset on Back in this configuration,
    // and this records that rather than asserting the opposite: what matters
    // is that focus management did not make it worse. `focus({ preventScroll:
    // true })` is why — without it, focusing the landmark would scroll the
    // page itself and the router would no longer be the only thing deciding
    // where the viewport sits. If Next starts restoring the offset, this line
    // fails and the right change is to assert the restored value.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
});
