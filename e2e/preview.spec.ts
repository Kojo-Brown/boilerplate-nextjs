import { test, expect } from "@playwright/test";

/**
 * Draft mode end to end, because three of its load-bearing claims are browser
 * behaviours that no unit test can make.
 *
 *  1. **The cookie survives the redirect.** `/api/preview` calls
 *     `draftMode().enable()` and returns its own `NextResponse.redirect`.
 *     Whether Next merges the mutable cookie into a response the handler
 *     constructed is a framework detail; `route.test.ts` can only observe that
 *     `enable()` was called.
 *  2. **The cookie actually changes what is served.** `/blog` is prerendered
 *     static with a 60-second window. The whole feature rests on Next skipping
 *     the full route cache — and its `"use cache"` entries — for a request
 *     carrying the bypass cookie. That is a property of the production server,
 *     not of the module graph.
 *  3. **A public reader is unaffected.** The failure that would matter most is
 *     an unpublished post reaching someone without a preview link, and the only
 *     honest test of it is a second browser context with no cookies hitting the
 *     same running server.
 *
 * Runs against `pnpm start`, not `next dev`: in development every route is
 * rendered on demand, so claims 2 and 3 would pass without draft mode existing.
 */

/** Unique per run — the dashboard is not reset between runs. */
const DRAFT_TITLE = `E2E draft ${Date.now()}`;

test.describe("Draft mode", () => {
  // Both configured projects collect every spec in `e2e/`, and the authoring
  // half of this flow needs the session `auth.setup.ts` saves. Skipping is
  // explicit rather than implied by a `storageState` override, because
  // "unauthenticated" is a project this feature genuinely has nothing to say
  // in — the public reader it does care about gets its own context below.
  test.skip(
    () => test.info().project.name === "unauthenticated",
    "needs the authenticated session from e2e/auth.setup.ts",
  );

  test("a signed preview link shows an unpublished post that the public cannot see", async ({
    page,
    browser,
  }) => {
    // ---- Author creates a post. Posts are created unpublished. -------------
    await page.goto("/posts");
    await page.getByRole("button", { name: "New Post" }).click();
    await page.getByLabel("Title").fill(DRAFT_TITLE);
    await page
      .getByLabel("Content")
      .fill("Only a preview session should be able to read this.");
    await page.getByRole("button", { name: "Create", exact: true }).click();

    const row = page
      .getByRole("article")
      .filter({ hasText: DRAFT_TITLE })
      .first();
    await expect(row).toBeVisible();
    await expect(row.getByText("Draft", { exact: true })).toBeVisible();

    // ---- Preview mints a token, redeems it, and lands on the post ----------
    await row.getByRole("button", { name: "Preview" }).click();

    // The URL is the post's own public path — proof the redirect came out of
    // the signed payload and that the round trip through /api/preview landed.
    await page.waitForURL(/\/blog\/[^/]+$/, { timeout: 15_000 });
    const draftUrl = page.url();

    await expect(page.getByTestId("preview-banner")).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: new RegExp(DRAFT_TITLE) }),
    ).toBeVisible();
    await expect(page.getByTestId("draft-badge")).toBeVisible();

    // ---- The draft is in the index too, and labelled ------------------------
    await page.goto("/blog");
    await expect(page.getByTestId("preview-banner")).toBeVisible();
    const draftLink = page.getByRole("link", {
      name: new RegExp(DRAFT_TITLE),
    });
    await expect(draftLink).toBeVisible();
    await expect(draftLink.getByTestId("draft-badge")).toBeVisible();

    // ---- A reader without the link sees none of it --------------------------
    // A second context, so there is no bypass cookie — the only honest way to
    // ask what an anonymous reader gets from the same running server.
    const publicContext = await browser.newContext();
    try {
      const publicPage = await publicContext.newPage();

      await publicPage.goto("/blog");
      await expect(publicPage.getByTestId("preview-banner")).toHaveCount(0);
      await expect(publicPage.getByText(DRAFT_TITLE)).toHaveCount(0);

      // The post's own URL renders the not-found boundary and none of the
      // draft's content.
      //
      // Asserted on content rather than on `response.status()`, and not for
      // convenience: under Partial Prerendering this route answers **200** even
      // for a slug that has never existed, because the static shell is flushed
      // before the dynamic hole reaches `notFound()`. That is pre-existing
      // behaviour on `main` — `/blog/definitely-not-a-real-post-id` returns 200
      // there too — and unrelated to draft mode, so this test does not pretend
      // to fix it. What matters here is what reaches the reader, and a status
      // assertion would have been both wrong and weaker.
      //
      // This is the assertion that earned its place: against the first version
      // of the read layer it found the draft's title and body being served to
      // this context in full. See `getPublishedPostById`.
      await publicPage.goto(draftUrl);
      await expect(publicPage.getByText(DRAFT_TITLE)).toHaveCount(0);
      await expect(
        publicPage.getByText(
          "Only a preview session should be able to read this",
        ),
      ).toHaveCount(0);
      // By role, because a bare text match also hits the document `<title>`.
      await expect(
        publicPage.getByRole("heading", { name: "Post not found" }),
      ).toBeVisible();
    } finally {
      await publicContext.close();
    }

    // ---- Exiting returns to the published view ------------------------------
    await page.goto("/blog");
    await page.getByRole("button", { name: "Exit preview" }).click();

    await page.waitForURL(/\/blog$/, { timeout: 15_000 });
    await expect(page.getByTestId("preview-banner")).toHaveCount(0);
    await expect(page.getByText(DRAFT_TITLE)).toHaveCount(0);
  });

  test("an unsigned request to /api/preview is refused and opens no session", async ({
    page,
  }) => {
    const forged = await page.request.get(
      "/api/preview?token=not-a-real-token",
    );
    expect(forged.status()).toBe(401);

    const missing = await page.request.get("/api/preview");
    expect(missing.status()).toBe(400);

    // The important half: a refused request must leave the browser in exactly
    // the state it was in — no banner, no drafts.
    await page.goto("/blog");
    await expect(page.getByTestId("preview-banner")).toHaveCount(0);
  });
});
