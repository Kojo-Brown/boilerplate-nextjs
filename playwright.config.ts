import { defineConfig, devices } from "@playwright/test";
import { PROJECT_FOR_SURFACE } from "./e2e/support/journey";

const PORT = process.env["PORT"] ?? "3000";
const BASE_URL =
  process.env["PLAYWRIGHT_BASE_URL"] ?? `http://localhost:${PORT}`;

// The journey suites, which are the two that share `e2e/support/journey.ts`.
// They are named here because the projects that run them and the projects that
// must *not* run them both need the same list: without the `testIgnore` below,
// `chromium` and `unauthenticated` would each pick them up as well and walk the
// journey at a width neither project pins, with a stored session the journey
// exists to create for itself.
const JOURNEY_SPECS = ["**/a11y-journey.spec.ts", "**/visual-journey.spec.ts"];

// CI installs the Chromium build pinned by `@playwright/test`, which is the
// default and needs no path. `PLAYWRIGHT_CHROMIUM_PATH` is the same hatch
// `A11Y_CHROMIUM_PATH` gives the static accessibility gate, for a sandbox that
// cannot reach `cdn.playwright.dev` and already has a Chromium on disk.
//
// It is an honest substitute for the a11y half, whose conclusions are about
// markup and a stylesheet, and it is *not* one for the visual half: a different
// Chromium rasterises text differently, so every baseline would differ by a few
// hundred pixels for no reason anybody could act on. That is why the baselines
// are recorded in CI rather than on a contributor's machine — see
// docs/visual-regression.md.
// Each journey project presents itself as a distinct client, and this is not a
// convenience — without it the suite rate-limits itself.
//
// The journey signs in, so every walk of it makes two requests under
// `AUTHENTICATION_POLICY`: the rejected registration and the sign-in.
// `RATE_LIMIT_RULES` gives `/login` and `/register` Server Actions **one shared
// budget of ten a minute**, keyed on the client address — so the four tests
// here (two specs × two projects) spend eight of those ten between them, and a
// single CI retry spends more than the budget has. The failure is a bad one to
// debug, because a rate-limited action comes back without `fieldErrors` and is
// therefore reported as a toast rather than as the field error the journey is
// waiting for: the symptom is "the duplicate-email message never appeared",
// twenty lines away from the cause.
//
// So each project gets its own bucket, and each *run* gets its own too, because
// two runs a minute apart would otherwise collide the same way. This does not
// weaken anything: four requests still land in one bucket, so a budget that
// regressed to three would still fail here. The addresses are from
// `2001:db8::/32`, the range reserved for documentation, and the limiter buckets
// IPv6 to /64 — the first four groups — which is why the run and the project go
// in the third and fourth.
const RUN_ID = Date.now().toString(16).slice(-4);
const clientIdentity = (project: number): { "x-forwarded-for": string } => ({
  "x-forwarded-for": `2001:db8:${RUN_ID}:${project}::1`,
});

const chromiumPath = process.env["PLAYWRIGHT_CHROMIUM_PATH"];
const launchOptions =
  chromiumPath === undefined || chromiumPath === ""
    ? {}
    : { launchOptions: { executablePath: chromiumPath } };

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

  // Flat, one directory per project, named by the journey step. No `{platform}`
  // and no `{projectName}` duplication inside the file name: the step ids are
  // unique, so the path is predictable enough for
  // `scripts/assert-visual-baselines.ts` to compute the expected set and report
  // both a missing baseline and an orphaned one.
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",

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
        ...launchOptions,
      },
      dependencies: ["setup"],
      testIgnore: JOURNEY_SPECS,
    },
    {
      name: "unauthenticated",
      use: { ...devices["Desktop Chrome"], ...launchOptions },
      testIgnore: JOURNEY_SPECS,
    },

    // The two journey projects. Both walk `e2e/support/journey.ts`; the width is
    // the whole difference between them, and it is a difference that matters
    // twice over. `target-size` (2.5.8) is a touch criterion, so the pass that
    // can fail it is the narrow one — the static gate runs the rule at 1280px
    // and says in its own documentation that this is the gap. And the
    // navigation drawer is `lg:hidden`, so at 1280px it does not exist: one of
    // the two interactive overlays in this application is only reachable here.
    //
    // No `dependencies: ["setup"]` and no `storageState`, on purpose. The
    // journey signs itself in, because the registration form, a rejected
    // submit and the sign-in form are three of the states being measured and a
    // restored session skips all three.
    {
      name: PROJECT_FOR_SURFACE.desktop,
      testMatch: JOURNEY_SPECS,
      use: {
        ...devices["Desktop Chrome"],
        // The same viewport the static gate audits at, so a finding that
        // appears here and not there is a statement about interaction rather
        // than about width.
        viewport: { width: 1280, height: 900 },
        storageState: { cookies: [], origins: [] },
        extraHTTPHeaders: clientIdentity(1),
        ...launchOptions,
      },
    },
    {
      name: PROJECT_FOR_SURFACE.mobile,
      testMatch: JOURNEY_SPECS,
      use: {
        // A real device descriptor rather than a narrow viewport: `hasTouch`
        // and `isMobile` are what make `target-size` the criterion it is, and
        // a 390px-wide desktop Chrome is not a phone.
        ...devices["Pixel 5"],
        storageState: { cookies: [], origins: [] },
        extraHTTPHeaders: clientIdentity(2),
        ...launchOptions,
      },
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
