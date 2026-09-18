import { test, expect } from "@playwright/test";

/**
 * Bucketing is a property of a *browser over time*, and that is the one thing
 * the unit suite cannot observe.
 *
 * `assignment.test.ts` proves the precedence rules, `edge.test.ts` proves the
 * response is built correctly, and `proxy.test.ts` proves the three concerns
 * compose in the right order. None of them proves the thing the feature
 * actually promises: that a real browser, given a real `Set-Cookie`, sends it
 * back and sees the same arm — and that the URL never moves while that happens.
 * Only a browser can say so, and this file is where that claim is made.
 */

// Every test here is a fresh, logged-out visitor. A session cookie would only
// add noise, and the feature is about people who do not have one.
test.use({ storageState: { cookies: [], origins: [] } });

const VISITOR_COOKIE = "bkt_vid";
const ASSIGNMENT_COOKIE = "bkt_exp";

const CONTROL_LEAD = "Month-to-month, with annual billing available";
const TREATMENT_LEAD = "Annual billing, with the month-to-month rate alongside";

test.describe("Bucketed routing: /pricing", () => {
  test("serves a pricing page and mints both cookies on a first visit", async ({
    page,
    context,
  }) => {
    await page.goto("/pricing");

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pricing");
    expect(new URL(page.url()).pathname).toBe("/pricing");

    const cookies = await context.cookies();
    const names = cookies.map((cookie) => cookie.name);
    expect(names).toContain(VISITOR_COOKIE);
    expect(names).toContain(ASSIGNMENT_COOKIE);

    // HttpOnly is the claim the module makes and the one a browser can check:
    // nothing in the page is allowed to read or rewrite a cohort.
    for (const name of [VISITOR_COOKIE, ASSIGNMENT_COOKIE]) {
      expect(cookies.find((cookie) => cookie.name === name)?.httpOnly).toBe(
        true,
      );
    }
  });

  test("keeps the same arm across visits", async ({ page }) => {
    // The whole point of the cookie. Ten loads, one arm.
    await page.goto("/pricing");
    const first = await page.getByRole("heading", { level: 1 }).textContent();
    const lead = await page.locator("h1 + p, h1 ~ p").first().textContent();

    for (let visit = 0; visit < 9; visit += 1) {
      await page.goto("/pricing");
      expect(await page.getByRole("heading", { level: 1 }).textContent()).toBe(
        first,
      );
      expect(await page.locator("h1 + p, h1 ~ p").first().textContent()).toBe(
        lead,
      );
    }
  });

  test("does not re-mint the cookies on a second visit", async ({
    page,
    context,
  }) => {
    // `Set-Cookie` on every page view is a header on every page view and, in a
    // shared cache, a reason not to store the response at all.
    await page.goto("/pricing");
    const before = (await context.cookies()).find(
      (cookie) => cookie.name === VISITOR_COOKIE,
    )?.value;

    const response = await page.goto("/pricing");
    const after = (await context.cookies()).find(
      (cookie) => cookie.name === VISITOR_COOKIE,
    )?.value;

    expect(after).toBe(before);
    expect(response?.headers()["set-cookie"]).toBeUndefined();
  });

  test("keeps a shared cache off the canonical path", async ({ page }) => {
    // `Vary: Cookie` would be the correct answer and Next overwrites it — see
    // the note in next.config.ts. Without `private`, a CDN stores whichever arm
    // the first visitor after a purge happened to get and serves it to
    // everyone behind it.
    const response = await page.goto("/pricing");
    const cacheControl = response?.headers()["cache-control"] ?? "";

    expect(cacheControl).toContain("private");
    expect(cacheControl).not.toContain("s-maxage");
  });
});

test.describe("Forcing an arm", () => {
  test("shows the control layout when it is forced", async ({ page }) => {
    await page.goto("/pricing?bkt_pricing-cta=control");
    await expect(page.getByText(CONTROL_LEAD)).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Get started" }).first(),
    ).toBeVisible();
  });

  test("shows the treatment layout when it is forced, at the same URL", async ({
    page,
  }) => {
    // The claim a redirect would break: the arm renders and the address bar
    // still says /pricing.
    await page.goto("/pricing?bkt_pricing-cta=annual-first");

    await expect(page.getByText(TREATMENT_LEAD)).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Start annual plan" }).first(),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/pricing");
  });

  test("survives a reload, because the query string survives the rewrite", async ({
    page,
  }) => {
    await page.goto("/pricing?bkt_pricing-cta=annual-first");
    await page.reload();
    await expect(page.getByText(TREATMENT_LEAD)).toBeVisible();
  });

  test("is not counted as a measurement", async ({ page }) => {
    // Anyone can send the parameter, so a link that forces an arm may change
    // what one person sees and must not move the numbers.
    const response = await page.goto("/pricing?bkt_pricing-cta=annual-first");
    expect(response?.headers()["x-experiment-exposure"]).toBeUndefined();
  });

  test("does not persist the forced arm", async ({ page, context }) => {
    await page.goto("/pricing?bkt_pricing-cta=annual-first");
    const stored = (await context.cookies()).find(
      (cookie) => cookie.name === ASSIGNMENT_COOKIE,
    );
    // Either no assignment cookie at all (nothing to persist yet) or one that
    // does not name the forced arm. What must not happen is the override
    // becoming the visitor's cohort for a year.
    expect(stored?.value ?? "").not.toContain("annual-first");
  });

  test("ignores an arm the experiment does not have", async ({ page }) => {
    await page.goto("/pricing?bkt_pricing-cta=does-not-exist");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pricing");
  });
});

test.describe("Geo targeting", () => {
  // `x-vercel-ip-country` is a trusted header — trusted because the platform
  // that sets it also strips a client-supplied copy. There is no platform in
  // front of this server, which is exactly why the header can be set from a
  // test here and cannot be set by a visitor in production.
  test.use({ extraHTTPHeaders: { "x-vercel-ip-country": "US" } });

  test("buckets targeted traffic into the experiment", async ({ page }) => {
    const response = await page.goto("/pricing");
    // Exposure is reported for a measured assignment, and only for one.
    expect(response?.headers()["x-experiment-exposure"]).toMatch(
      /^pricing-cta:(control|annual-first)$/,
    );
  });

  test("splits targeted visitors across both arms", async ({ browser }) => {
    // Ten independent visitors, each with their own cookie jar. A 50/50 split
    // producing ten identical arms is a 1-in-512 coincidence; seeing both is
    // the evidence that the hash is reached at all, rather than every visitor
    // falling through to the control by some other route.
    const leads = new Set<string>();

    for (let visitor = 0; visitor < 10; visitor += 1) {
      const context = await browser.newContext({
        extraHTTPHeaders: { "x-vercel-ip-country": "US" },
      });
      const page = await context.newPage();
      await page.goto("/pricing");
      const lead = await page.locator("h1 ~ p").first().textContent();
      if (lead) leads.add(lead);
      await context.close();
    }

    expect(leads.size).toBe(2);
  });
});

test.describe("Untargeted traffic", () => {
  test("is served the control and is not counted", async ({ page }) => {
    // No geo header at all, so the country is unknown, and an experiment that
    // lists countries excludes traffic it cannot place.
    const response = await page.goto("/pricing");

    await expect(page.getByText(CONTROL_LEAD)).toBeVisible();
    expect(response?.headers()["x-experiment-exposure"]).toBeUndefined();
  });
});

test.describe("The variant pages themselves", () => {
  test("render directly, for reviewing both arms side by side", async ({
    page,
  }) => {
    await page.goto("/pricing/v/annual-first");
    await expect(page.getByText(TREATMENT_LEAD)).toBeVisible();
  });

  test("ask not to be indexed", async ({ page }) => {
    // They are near-identical pages at different URLs; indexing them is the
    // duplicate-content problem the rewrite exists to avoid.
    await page.goto("/pricing/v/annual-first");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /noindex/,
    );
  });

  test("render the not-found boundary for an arm that does not exist", async ({
    page,
  }) => {
    // Note the status: **200**, not 404, and that is Cache Components rather
    // than a bug here. The shell is prerendered and sent before the page body
    // runs, so a `notFound()` below it cannot change a status line that has
    // already gone out — it swaps in the boundary instead. `/photos/nonsense`
    // answers exactly the same way on this build, and it predates this
    // feature. What is asserted is therefore what a visitor actually gets.
    const response = await page.goto("/pricing/v/nonsense");

    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "No such pricing variant" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Back to pricing" }),
    ).toBeVisible();
  });
});
