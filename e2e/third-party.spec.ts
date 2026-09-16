import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Whether the facade actually keeps the third party off the page.
 *
 * Everything else about this feature is asserted somewhere cheaper.
 * `scripts/assert-third-party-scripts.ts` checks the declaration — the entry
 * exists, it is marked as a facade, nothing preconnects it.
 * `video-facade.test.tsx` checks the render — no iframe, no mention of the
 * origin, `preconnect` not called. Neither of them can see a *request*, and a
 * request is the entire subject: the component could be perfect and a
 * `<link rel="preload">` emitted three layers up, or a stray prefetch in the
 * document, would still have every reader of every article paying for a player
 * they never asked for.
 *
 * So this watches the network. It is the only place in the repository where the
 * claim "nothing is contacted until the press" is checked against what the
 * browser did rather than against what the source says it will do.
 *
 * The player itself is stubbed rather than fetched. A real request to YouTube
 * would make this test's result depend on a third party's availability — which
 * is precisely the dependency the facade exists to defer — and would make it
 * unrunnable on an offline runner. Interception still records the attempt,
 * which is the assertion.
 */

// Articles are public; a session would only add noise.
test.use({ storageState: { cookies: [], origins: [] } });

const EMBED_HOST = "www.youtube-nocookie.com";
const EMBED_GLOB = `**://${EMBED_HOST}/**`;

/**
 * Records every request the page makes to the embed origin, and answers them
 * itself so nothing leaves the runner.
 */
async function watchEmbedRequests(page: Page): Promise<string[]> {
  const requested: string[] = [];

  await page.route(EMBED_GLOB, async (route) => {
    requested.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>stub player</title>",
    });
  });

  // `page.route` does not see requests a browser never makes through the
  // network stack, so the raw event is recorded too: a DNS-only preconnect or a
  // speculative prefetch shows up here even when the route handler does not.
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === EMBED_HOST) {
      requested.push(request.url());
    }
  });

  return requested;
}

/**
 * Waits until the page has loaded *and* the browser's idle queue has drained.
 *
 * Deliberately not `waitForLoadState("networkidle")`. The claim being tested is
 * "nothing requested the player", and the moment to check it is after the work
 * that would have done so has had its turn — which is `load` plus an idle
 * callback, since that is when an `afterInteractive` script runs and when
 * anything deferred to `requestIdleCallback` fires. Network quiescence is a
 * different and weaker property, and it is one this page cannot reliably reach:
 * the poster is served through the image optimiser from a remote CDN, so a
 * runner that cannot reach that CDN waits five hundred milliseconds of silence
 * that never comes. Playwright discourages `networkidle` for exactly this
 * reason.
 *
 * The 2 s `timeout` is the idle callback's own escape hatch, not a sleep: it
 * only applies on a page that never goes idle, and a page that never goes idle
 * has already had two seconds in which to request something.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestIdleCallback(() => resolve(), { timeout: 2000 });
      }),
  );
}

/**
 * Opens an article and waits for it to settle.
 *
 * Deliberately asserts nothing about the facade: a helper that waited for the
 * play button before the caller looked at the network would report "button not
 * found" when the facade regresses into an eager embed, which is the least
 * informative way to describe exactly that failure. It waits for the article's
 * `<h1>` instead — that renders whether or not the facade works, so a
 * regression is still reported as the request it made.
 *
 * It tries the listed posts in order rather than trusting the first, because
 * `/blog` is a cached list and a cached list can name a post that is gone.
 * `revalidate-webhook.spec.ts` creates a post, revalidates, and deletes it; run
 * before this file, it leaves `/blog` advertising a dead id whose page answers
 * 200 with the not-found boundary. That is a real hazard for any reader
 * arriving from a stale list, not something to paper over with a fixed slug —
 * but it is not this file's subject either, so it walks past it.
 */
async function openAnArticle(page: Page): Promise<void> {
  await page.goto("/blog");

  const hrefs = await page
    .locator('a[href^="/blog/"]')
    .evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.getAttribute("href") ?? ""),
    );

  expect(hrefs.length, "/blog listed no posts to open").toBeGreaterThan(0);

  for (const href of hrefs) {
    await page.goto(href);
    const heading = page.getByRole("heading", { level: 1 });
    try {
      await heading.waitFor({ state: "visible", timeout: 5_000 });
    } catch {
      // A listed post that no longer resolves. Try the next one.
      continue;
    }
    await settle(page);
    return;
  }

  throw new Error(
    `none of the ${hrefs.length} post(s) listed on /blog rendered an article`,
  );
}

test.describe("Third-party embed facade", () => {
  test("loads an article without contacting the player", async ({ page }) => {
    const requested = await watchEmbedRequests(page);

    await openAnArticle(page);

    expect(requested).toEqual([]);
    expect(await page.locator("iframe").count()).toBe(0);

    // Asserted last, so a regression is reported as the request it made rather
    // than as a control that went missing.
    await expect(
      page.getByRole("button", { name: /^Play video:/ }),
    ).toBeVisible();
  });

  test("loads the player on the press, and only on the press", async ({
    page,
  }) => {
    const requested = await watchEmbedRequests(page);

    await openAnArticle(page);
    await page.getByRole("button", { name: /^Play video:/ }).click();

    const frame = page.locator(`iframe[src*="${EMBED_HOST}"]`);
    await expect(frame).toBeVisible();
    await expect
      .poll(() => requested.length, {
        message: "the player was never requested after the press",
      })
      .toBeGreaterThan(0);

    // The activation press is the user gesture the browser's autoplay policy
    // wants, so the viewer does not have to press a second time inside the
    // frame.
    expect(await frame.getAttribute("src")).toContain("autoplay=1");
  });

  test("is operable from the keyboard", async ({ page }) => {
    await watchEmbedRequests(page);
    await openAnArticle(page);

    const control = page.getByRole("button", { name: /^Play video:/ });
    await control.focus();
    await page.keyboard.press("Enter");

    await expect(page.locator(`iframe[src*="${EMBED_HOST}"]`)).toBeVisible();
  });
});

test.describe("Declared third-party origins", () => {
  test("an unconfigured deployment mounts no analytics script", async ({
    page,
  }) => {
    // `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is unset here, as it is in a fresh clone
    // and in CI. The supported behaviour is that nothing is loaded at all —
    // not that a script loads and reports to nowhere.
    const analytics: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).hostname.endsWith("plausible.io")) {
        analytics.push(request.url());
      }
    });

    await page.goto("/");
    await settle(page);

    expect(analytics).toEqual([]);
    expect(await page.locator('script[src*="plausible.io"]').count()).toBe(0);
  });

  test("warms the image CDN it is about to use", async ({ page }) => {
    await page.goto("/photos");
    await expect(
      page.locator(
        'link[rel="preconnect"][href="https://images.unsplash.com"]',
      ),
    ).toHaveCount(1);
  });
});
