import { test, expect } from "@playwright/test";

/**
 * Interception is a browser behaviour, and it is the one thing the unit suite
 * cannot observe.
 *
 * `photo-modal.test.tsx` proves the dialog closes by navigating; `photo-grid
 * .test.tsx` proves the tiles are real links; `interception.test.ts` proves
 * the files are where the router expects them. None of that proves the router
 * actually swaps one for the other — that the *same URL* renders a modal after
 * a click and a full page after a reload. Only a real browser can say so, and
 * this file is where that claim is made.
 */

// The gallery is public; a session would only add noise.
test.use({ storageState: { cookies: [], origins: [] } });

const PHOTO_ID = "ocean-at-sunset";
const PHOTO_TITLE = "Ocean at sunset";

test.describe("Intercepting routes: /photos", () => {
  test("a click from the gallery opens a modal and changes the URL", async ({
    page,
  }) => {
    await page.goto("/photos");
    await page
      .getByRole("link", { name: new RegExp(PHOTO_TITLE, "i") })
      .click();

    // Both halves of the promise: the overlay is up, and the address bar is
    // somewhere real. A client-state dialog would satisfy only the first.
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/photos/${PHOTO_ID}$`));

    // The gallery is still mounted underneath — that is what makes this an
    // interception rather than a navigation to a page that looks like a modal.
    await expect(
      page.getByRole("heading", { level: 1, name: "Photos" }),
    ).toBeVisible();
  });

  test("Escape closes the modal by navigating back to the gallery", async ({
    page,
  }) => {
    await page.goto("/photos");
    await page
      .getByRole("link", { name: new RegExp(PHOTO_TITLE, "i") })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page).toHaveURL(/\/photos$/);
  });

  test("browser Back closes the modal", async ({ page }) => {
    await page.goto("/photos");
    await page
      .getByRole("link", { name: new RegExp(PHOTO_TITLE, "i") })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.goBack();

    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page).toHaveURL(/\/photos$/);
  });

  test("the shared URL renders a full page, not a modal", async ({ page }) => {
    // What someone else gets when the link is pasted to them: a hard
    // navigation, which the router does not intercept.
    await page.goto(`/photos/${PHOTO_ID}`);

    await expect(
      page.getByRole("heading", { level: 1, name: PHOTO_TITLE }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("reloading with the modal open falls through to the full page", async ({
    page,
  }) => {
    await page.goto("/photos");
    await page
      .getByRole("link", { name: new RegExp(PHOTO_TITLE, "i") })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.reload();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { level: 1, name: PHOTO_TITLE }),
    ).toBeVisible();
  });

  test("an unknown photo ID renders the not-found boundary", async ({
    page,
  }) => {
    await page.goto("/photos/not-a-real-photo");

    await expect(
      page.getByRole("heading", { name: /photo not found/i }),
    ).toBeVisible();
  });

  test("the @modal slot adds nothing to routes that are not photos", async ({
    page,
  }) => {
    // `default.tsx` returning null is what keeps every other route's markup —
    // and its static shell — exactly as it was before the slot existed.
    await page.goto("/");

    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
