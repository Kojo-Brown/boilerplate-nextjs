import { test as setup, expect } from "@playwright/test";
import path from "path";

const AUTH_FILE = path.join(__dirname, ".auth/user.json");

const TEST_EMAIL = process.env["E2E_USER_EMAIL"] ?? "e2e-test@example.com";
const TEST_PASSWORD = process.env["E2E_USER_PASSWORD"] ?? "TestPassword123!";
const TEST_NAME = "E2E Test User";

setup("create authenticated user and save session", async ({ page }) => {
  await page.goto("/register");

  const nameInput = page.getByLabel("Name");
  const emailInput = page.getByLabel("Email");
  const passwordInput = page.getByLabel("Password");

  await nameInput.fill(TEST_NAME);
  await emailInput.fill(TEST_EMAIL);
  await passwordInput.fill(TEST_PASSWORD);

  await page.getByRole("button", { name: /create account/i }).click();

  // If the email already exists, sign in instead.
  const url = page.url();
  if (!url.includes("/dashboard")) {
    await page.goto("/login");
    await page.getByLabel("Email").fill(TEST_EMAIL);
    await page.getByLabel("Password").fill(TEST_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
  }

  await page.waitForURL("**/dashboard", { timeout: 15_000 });
  await expect(page).toHaveURL(/\/dashboard/);

  await page.context().storageState({ path: AUTH_FILE });
});
