import { defineConfig, devices } from "@playwright/test";

const PORT = process.env["PORT"] ?? "3000";
const BASE_URL =
  process.env["PLAYWRIGHT_BASE_URL"] ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Points at `e2e/tsconfig.json`, which exists for one mapping: `server-only`
  // resolves to the marker package's own empty module rather than to the entry
  // that throws. Playwright runs these specs in plain Node, which sets neither
  // export condition, so `revalidate-webhook.spec.ts` — which imports
  // `@/lib/prisma` to seed a post and `@/lib/webhooks/signature` to sign the
  // request — would otherwise fail at import on the marker that is there to stop
  // a *browser bundle* importing it. Same reasoning as the alias in
  // `vitest.config.ts`; `scripts/assert-server-only.ts` is what checks the
  // boundary neither runner can see.
  tsconfig: "./e2e/tsconfig.json",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  // Omitted rather than set to `undefined` locally, so Playwright applies its
  // own default worker count — `exactOptionalPropertyTypes` rejects the latter.
  ...(process.env["CI"] && { workers: 1 }),
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
