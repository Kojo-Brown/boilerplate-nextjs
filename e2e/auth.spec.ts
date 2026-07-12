import { test, expect } from "@playwright/test";
import { faker } from "@faker-js/faker";

// These tests create their own users so they run in an unauthenticated context.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Auth flow", () => {
  test("register with new credentials → dashboard redirect", async ({
    page,
  }) => {
    const email = faker.internet.email({ provider: "e2e-test.local" });

    await page.goto("/register");
    await expect(page).toHaveTitle(/create account/i);

    await page.getByLabel("Name").fill("Test User");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("TestPassword123!");

    await page.getByRole("button", { name: /create account/i }).click();

    await page.waitForURL("**/dashboard", { timeout: 15_000 });
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("login with valid credentials → dashboard redirect", async ({
    page,
  }) => {
    const email = faker.internet.email({ provider: "e2e-test.local" });
    const password = "TestPassword123!";

    // Register first so credentials exist.
    await page.goto("/register");
    await page.getByLabel("Name").fill("Login Test");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /create account/i }).click();
    await page.waitForURL("**/dashboard", { timeout: 15_000 });

    // Clear session cookies to simulate a new visit.
    await page.context().clearCookies();

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();

    await page.waitForURL("**/dashboard", { timeout: 15_000 });
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("login with wrong password shows error message", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel("Email").fill("nobody@e2e-test.local");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByText(/invalid email or password/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page).toHaveURL(/\/login/);
  });

  test("logout redirects to /login and session is cleared", async ({
    page,
  }) => {
    const email = faker.internet.email({ provider: "e2e-test.local" });
    const password = "TestPassword123!";

    // Register and land on dashboard.
    await page.goto("/register");
    await page.getByLabel("Name").fill("Logout Test");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /create account/i }).click();
    await page.waitForURL("**/dashboard", { timeout: 15_000 });

    // Click the sign-out button in the nav.
    const signOutButton = page
      .getByRole("button", { name: /sign out|log out/i })
      .first();
    await signOutButton.click();

    await page.waitForURL("**/login", { timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);

    // Confirm the session is truly gone — protected route redirects.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});
