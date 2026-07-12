import { test, expect } from "@playwright/test";
import { faker } from "@faker-js/faker";

// Uses the authenticated session saved by auth.setup.ts (chromium project).
test.describe("Form submission (authenticated)", () => {
  test("create a new post via dialog form", async ({ page }) => {
    await page.goto("/dashboard/posts");

    // Open the create post dialog.
    await page.getByRole("button", { name: /new post/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const title = faker.lorem.sentence(4);
    const content = faker.lorem.paragraph();

    await dialog.getByLabel(/title/i).fill(title);

    const contentField = dialog.getByLabel(/content/i);
    if (await contentField.isVisible()) {
      await contentField.fill(content);
    }

    await dialog.getByRole("button", { name: /create|save|submit/i }).click();

    // Dialog should close on success.
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });

    // The new post title should appear in the list.
    await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 });
  });

  test("create post dialog requires a title", async ({ page }) => {
    await page.goto("/dashboard/posts");

    await page.getByRole("button", { name: /new post/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Leave title empty and attempt submit.
    await dialog.getByRole("button", { name: /create|save|submit/i }).click();

    // Dialog stays open because the title is required.
    await expect(dialog).toBeVisible();
  });
});

test.describe("Register form validation", () => {
  // Runs without any session cookie.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("register form stays on page when all fields are empty", async ({
    page,
  }) => {
    await page.goto("/register");

    await page.getByRole("button", { name: /create account/i }).click();

    await expect(page).toHaveURL(/\/register/);
  });

  test("login form stays on page when email is empty", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel("Password").fill("TestPassword123!");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page).toHaveURL(/\/login/);
  });
});
