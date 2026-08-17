import { test, expect } from "@playwright/test";

/**
 * Theming is a browser behaviour, and it is the part of this control the unit
 * suite cannot observe.
 *
 * `theme-toggle.test.tsx` proves the button cycles and labels itself;
 * `theme-control.test.tsx` proves every shell mounts it. Neither proves the
 * thing the user actually cares about — that clicking it repaints the page,
 * that the choice survives a navigation, and that the hydration placeholder
 * resolves to the stored theme instead of sticking. Those are `localStorage`,
 * a class on `<html>`, and a cascade, none of which exist in jsdom in a form
 * worth asserting on. This file is where those claims are made.
 */

// The control is public chrome; a session would only add noise.
test.use({
  storageState: { cookies: [], origins: [] },
  // Pinned so `system` has a known resolution and the light → dark transition
  // is an observable change rather than a coincidence of the runner's settings.
  colorScheme: "light",
});

const toggle = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: /theme/i }).first();

test.describe("Theme control", () => {
  test("cycles system → light → dark and repaints the page", async ({
    page,
  }) => {
    await page.goto("/");
    const button = toggle(page);

    // Starts on `system`, which resolves light here, so `.dark` is absent.
    await expect(button).toHaveAttribute("aria-label", "System theme");
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    await button.click();
    await expect(button).toHaveAttribute("aria-label", "Light theme");
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    await button.click();
    await expect(button).toHaveAttribute("aria-label", "Dark theme");
    // The class is what every `dark:` utility and every `.dark` token override
    // keys on — see docs/styling.md. Without it the label would be the only
    // thing that changed.
    await expect(page.locator("html")).toHaveClass(/dark/);

    await button.click();
    await expect(button).toHaveAttribute("aria-label", "System theme");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });

  test("the dark class actually changes what is painted", async ({ page }) => {
    await page.goto("/");
    const body = page.locator("body");

    const light = await body.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );

    await toggle(page).click(); // light
    await toggle(page).click(); // dark
    await expect(page.locator("html")).toHaveClass(/dark/);

    const dark = await body.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );

    // Asserting inequality rather than a literal colour: the tokens are free to
    // change in `globals.css`, but a theme that does not repaint is a bug in
    // any palette.
    expect(dark).not.toBe(light);
  });

  test("the choice survives a navigation to another shell", async ({
    page,
  }) => {
    await page.goto("/");
    await toggle(page).click();
    await toggle(page).click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    // `/blog` is a different layout with its own copy of the control, and an
    // ISR page rather than a static one — the persisted theme has to reach both.
    await page.goto("/blog");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(toggle(page)).toHaveAttribute("aria-label", "Dark theme");
  });

  test("the placeholder resolves to the stored theme after hydration", async ({
    page,
  }) => {
    await page.goto("/");
    await toggle(page).click();
    await toggle(page).click(); // dark, now in localStorage

    await page.reload();

    // The server cannot know the theme, so the prerendered button is the
    // neutral "Theme" placeholder. If the hydration gate ever failed to hand
    // over, the label would still read "Theme" here.
    await expect(toggle(page)).toHaveAttribute("aria-label", "Dark theme");
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("is reachable on every public shell", async ({ page }) => {
    for (const route of ["/", "/login", "/register", "/blog", "/photos"]) {
      await page.goto(route);
      await expect(toggle(page), `no theme control on ${route}`).toBeVisible();
    }
  });
});
