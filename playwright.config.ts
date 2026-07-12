import { defineConfig, devices } from "@playwright/test";

const PORT = process.env["PORT"] ?? "3000";
const BASE_URL = process.env["PLAYWRIGHT_BASE_URL"] ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  workers: process.env["CI"] ? 1 : undefined,
  reporter: process.env["CI"] ? "github" : "list",

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "unauthenticated",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "pnpm start",
    url: BASE_URL,
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
    env: {
      DATABASE_URL: process.env["DATABASE_URL"] ?? "",
      NEXTAUTH_SECRET: process.env["NEXTAUTH_SECRET"] ?? "e2e-test-secret",
      AUTH_SECRET: process.env["AUTH_SECRET"] ?? "e2e-test-secret",
      NEXTAUTH_URL: BASE_URL,
    },
  },
});
