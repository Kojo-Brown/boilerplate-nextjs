import { test, expect } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { SIGNATURE_HEADER, signWebhookPayload } from "@/lib/webhooks/signature";

/**
 * The revalidation webhook against a real production server, because its two
 * load-bearing claims are runtime behaviours that no unit test can make.
 *
 *  1. **`revalidateTag` is callable from a Route Handler.** Its sibling
 *     `updateTag` is not: Next throws E872 for any caller whose page ends in
 *     `/route`, and `refresh()` throws E870 the same way. A unit suite mocks
 *     `next/cache`, and the mock is exactly what makes those throws disappear —
 *     so a webhook wired to `invalidate()` passes every unit test and answers
 *     500 to every real delivery. Only a running server can tell the two apart.
 *
 *  2. **Dropping the tag actually changes what the next reader is served.** The
 *     blog's cached read is a `"use cache"` entry with a 60-second window. That
 *     an out-of-band write is *not* visible until the tag is dropped, and *is*
 *     immediately after, is a property of the production cache, not of the
 *     module graph.
 *
 * The post is inserted straight through Prisma rather than through the
 * dashboard, and that is the point: a Server Action would call `invalidate()`
 * itself, so the cache would already be correct and the webhook would have
 * nothing to prove. Writing behind the application's back is what a CMS, a
 * migration or a restored backup actually does.
 *
 * Runs against `pnpm start`, not `next dev`: in development nothing is cached,
 * so step 2 would pass without the webhook existing.
 */

/** Unique per run — `/blog` is not reset between runs. */
const TITLE = `E2E webhook post ${Date.now()}`;

let postId: string | undefined;
let authorId: string | undefined;

test.beforeAll(async () => {
  // The signer in this process and the one in the server must derive the same
  // key. `playwright.config.ts` passes `NEXTAUTH_SECRET` straight through, so
  // they agree as long as it is set — and if it is not, the server would not
  // have booted at all (the schema requires 32 characters).
  expect(
    process.env["NEXTAUTH_SECRET"],
    "NEXTAUTH_SECRET must be set so this process signs with the same key as the server",
  ).toBeTruthy();
});

test.afterAll(async () => {
  if (postId) await prisma.post.delete({ where: { id: postId } });
  if (authorId) await prisma.user.delete({ where: { id: authorId } });
  await prisma.$disconnect();
});

test.describe("On-demand revalidation webhook", () => {
  // Nothing here needs a session — the endpoint's authenticator is a signature,
  // which is the whole reason it exists — so this suite runs in whichever
  // project collects it first and skips the duplicate.
  test.skip(
    () => test.info().project.name === "chromium",
    "no session involved; the unauthenticated project covers it once",
  );

  test("rejects an unsigned call", async ({ request }) => {
    const response = await request.post("/api/revalidate", {
      data: { event: "blog.refresh" },
    });

    expect(response.status()).toBe(401);
  });

  test("rejects a signature made over a different body", async ({
    request,
  }) => {
    const signature = await signWebhookPayload(
      JSON.stringify({ event: "ping" }),
    );

    const response = await request.post("/api/revalidate", {
      headers: {
        [SIGNATURE_HEADER]: signature,
        "content-type": "application/json",
      },
      data: JSON.stringify({ event: "blog.refresh" }),
    });

    expect(response.status()).toBe(401);
  });

  test("a signed ping reaches the handler without dropping anything", async ({
    request,
  }) => {
    // The proof that the signature scheme works end to end, separated from the
    // proof that revalidation works — if this passes and the next test fails,
    // the problem is the cache, not the authenticator.
    const body = JSON.stringify({ event: "ping" });

    const response = await request.post("/api/revalidate", {
      headers: {
        [SIGNATURE_HEADER]: await signWebhookPayload(body),
        "content-type": "application/json",
      },
      data: body,
    });

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      revalidated: false,
      tags: [],
      event: "ping",
    });
  });

  test("clears a cached blog list that an out-of-band write left stale", async ({
    page,
    request,
  }) => {
    // ---- 1. Warm the cache, so what follows is a cache hit and not a first
    //         fill that would pick the new row up by accident. ---------------
    await page.goto("/blog");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // ---- 2. Write behind the application's back. -------------------------
    const author = await prisma.user.create({
      data: {
        email: `e2e-webhook-${Date.now()}@example.test`,
        name: "E2E Webhook Author",
      },
    });
    authorId = author.id;

    const created = await prisma.post.create({
      data: {
        title: TITLE,
        content: "Inserted without going through a Server Action.",
        published: true,
        authorId: author.id,
      },
    });
    postId = created.id;

    // ---- 3. The list is stale, and that is the correct behaviour. ---------
    await page.reload();
    await expect(page.getByText(TITLE)).toHaveCount(0);

    // ---- 4. Tell the application what happened. --------------------------
    const body = JSON.stringify({
      event: "post.published",
      postId: created.id,
    });

    const response = await request.post("/api/revalidate", {
      headers: {
        [SIGNATURE_HEADER]: await signWebhookPayload(body),
        "content-type": "application/json",
      },
      data: body,
    });

    // A 500 here is the E872 failure this whole spec exists to catch.
    expect(
      response.status(),
      await response.text().catch(() => "<no body>"),
    ).toBe(200);
    expect(await response.json()).toMatchObject({
      revalidated: true,
      tags: [`blog:post:${created.id}`, "blog:posts"],
    });

    // ---- 5. The next reader sees it. -------------------------------------
    await page.reload();
    await expect(page.getByText(TITLE)).toBeVisible();
  });
});
