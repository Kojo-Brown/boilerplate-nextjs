import { test, expect } from "@playwright/test";
import path from "path";
import fs from "fs";

// All tests here run WITHOUT a session (unauthenticated project).
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Protected routes (unauthenticated)", () => {
  const protectedPaths = [
    "/dashboard",
    "/dashboard/posts",
    "/dashboard/images",
    "/settings",
    "/profile",
  ];

  for (const routePath of protectedPaths) {
    test(`${routePath} redirects to /login`, async ({ page }) => {
      await page.goto(routePath);
      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
    });
  }

  test("login page is accessible without auth", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  });

  test("register page is accessible without auth", async ({ page }) => {
    await page.goto("/register");
    await expect(page).toHaveURL(/\/register/);
    await expect(
      page.getByRole("button", { name: /create account/i }),
    ).toBeVisible();
  });
});

test.describe("Protected routes (authenticated redirect)", () => {
  test("authenticated user visiting /login is redirected to /dashboard", async ({
    page,
    context,
  }) => {
    const authFile = path.join(__dirname, ".auth/user.json");

    if (!fs.existsSync(authFile)) {
      test.skip();
      return;
    }

    const raw = fs.readFileSync(authFile, "utf-8");
    const state = JSON.parse(raw) as {
      cookies: Parameters<typeof context.addCookies>[0];
      origins: unknown[];
    };

    await context.addCookies(state.cookies ?? []);
    await page.goto("/login");
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
  });
});
