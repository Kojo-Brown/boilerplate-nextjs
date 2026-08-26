import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
  refresh: vi.fn(),
}));

import { NextRequest } from "next/server";
import { revalidateTag } from "next/cache";
import { BLOG_POSTS_TAG, blogPostTag } from "@/lib/cache/tags";
import { isApiErrorBody } from "@/lib/api/errors";
import {
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
  signWebhookPayload,
} from "@/lib/webhooks/signature";
import { POST } from "./route";
import type { RevalidatePayload } from "./route";

/**
 * The revalidation webhook.
 *
 * Payloads are signed with the real signer, for the same reason
 * `api/preview/route.test.ts` mints real tokens: a mocked one would let every
 * case here pass against a handler that never verified anything.
 *
 * `next/cache` *is* mocked, and that is the limitation worth naming. The mock
 * is what makes `revalidateTag` callable at all outside a request — so these
 * tests can prove the handler drops the right tags, and cannot prove Next
 * accepts the call from a Route Handler. That claim is false for `updateTag`
 * (E872) and it fails at runtime rather than at typecheck, so it is asserted
 * against a real production server in `e2e/revalidate-webhook.spec.ts`.
 */
const mockRevalidateTag = vi.mocked(revalidateTag);

beforeEach(() => {
  vi.clearAllMocks();
});

async function post(body: string, header?: string | null): Promise<Response> {
  const signature =
    header === undefined ? await signWebhookPayload(body) : header;

  return POST(
    new NextRequest(
      new Request("https://example.test/api/revalidate", {
        method: "POST",
        body,
        ...(signature !== null && {
          headers: { [SIGNATURE_HEADER]: signature },
        }),
      }),
    ),
  );
}

function event(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

async function errorCode(response: Response): Promise<string> {
  const body: unknown = await response.json();
  return isApiErrorBody(body) ? body.error.code : "not-an-error-envelope";
}

function droppedTags(): string[] {
  return mockRevalidateTag.mock.calls.map(([tag]) => tag);
}

describe("POST /api/revalidate", () => {
  it("drops the post and list tags for a publish", async () => {
    const response = await post(
      event({ event: "post.published", postId: "post-1" }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as RevalidatePayload;
    expect(body).toEqual({
      revalidated: true,
      tags: [blogPostTag("post-1"), BLOG_POSTS_TAG],
      event: "post.published",
    });
    expect(droppedTags()).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
  });

  it("expires entries immediately rather than serving them stale", async () => {
    await post(event({ event: "blog.refresh" }));

    expect(mockRevalidateTag).toHaveBeenCalledWith(BLOG_POSTS_TAG, {
      expire: 0,
    });
  });

  it("answers a ping without dropping anything", async () => {
    // The "send test event" button in a CMS must be safe to press against
    // production.
    const response = await post(event({ event: "ping" }));

    expect(response.status).toBe(200);
    expect((await response.json()) as RevalidatePayload).toEqual({
      revalidated: false,
      tags: [],
      event: "ping",
    });
    expect(mockRevalidateTag).not.toHaveBeenCalled();
  });

  it("reports revalidated: false when nothing was dropped", async () => {
    // Not a synonym for "accepted" — the status code already says that. A
    // delivery log showing `revalidated: false` is how a misrouted event is
    // noticed at all.
    const body = (await (
      await post(event({ event: "ping" }))
    ).json()) as RevalidatePayload;

    expect(body.revalidated).toBe(false);
  });

  it("rejects an unsigned request", async () => {
    const response = await post(
      event({ event: "post.published", postId: "post-1" }),
      null,
    );

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("unauthorized");
    expect(mockRevalidateTag).not.toHaveBeenCalled();
  });

  it("rejects a signature made over a different body", async () => {
    const signature = await signWebhookPayload(
      event({ event: "post.published", postId: "post-1" }),
    );

    const response = await post(event({ event: "blog.refresh" }), signature);

    expect(response.status).toBe(401);
    expect(mockRevalidateTag).not.toHaveBeenCalled();
  });

  it("says so when the sender's clock is outside the window", async () => {
    // The one rejection that is spelled out rather than answered with a
    // uniform 401: it is what an integrator actually hits, and it leaks
    // nothing the caller did not just send.
    const body = event({ event: "blog.refresh" });
    const stale = await signWebhookPayload(body, {
      now: new Date(Date.now() - (SIGNATURE_TOLERANCE_SECONDS + 60) * 1000),
    });

    const response = await post(body, stale);

    expect(response.status).toBe(401);
    const parsed: unknown = await response.json();
    expect(isApiErrorBody(parsed) && parsed.error.message).toContain("clock");
  });

  it("does not tell a forged signature apart from a missing one", async () => {
    const body = event({ event: "blog.refresh" });

    const forged = await post(
      body,
      `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`,
    );
    const missing = await post(body, null);

    expect(forged.status).toBe(missing.status);
    const forgedBody: unknown = await forged.json();
    const missingBody: unknown = await missing.json();
    expect(forgedBody).toEqual(missingBody);
  });

  it("verifies the signature before parsing, so an unsigned caller learns nothing", async () => {
    // Ordering, asserted through the answer: a malformed payload without a
    // signature must look exactly like a well-formed one without a signature,
    // or the endpoint is an oracle for whether a guessed schema is right.
    const nonsense = await post("not json at all", null);
    const wellFormed = await post(event({ event: "ping" }), null);

    expect(nonsense.status).toBe(401);
    expect(await nonsense.json()).toEqual(await wellFormed.json());
  });

  it("answers 400 for a signed body that is not JSON", async () => {
    const response = await post("not json at all");

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
    expect(mockRevalidateTag).not.toHaveBeenCalled();
  });

  it("answers 422 naming the accepted events for an unknown one", async () => {
    const response = await post(
      event({ event: "post.publish", postId: "post-1" }),
    );

    expect(response.status).toBe(422);
    const parsed: unknown = await response.json();
    expect(
      isApiErrorBody(parsed) && parsed.error.fieldErrors?.["body"]?.[0],
    ).toContain("post.published");
    expect(mockRevalidateTag).not.toHaveBeenCalled();
  });

  it("answers 422 for a post event with no id", async () => {
    const response = await post(event({ event: "post.published" }));

    expect(response.status).toBe(422);
    expect(mockRevalidateTag).not.toHaveBeenCalled();
  });

  it("accepts whatever bytes the sender signed, whitespace included", async () => {
    // The property that makes this handler read the body as text: a sender
    // whose serialiser pretty-prints is not sending an invalid request.
    const body = JSON.stringify(
      { event: "post.updated", postId: "post-1" },
      null,
      2,
    );

    const response = await post(body);

    expect(response.status).toBe(200);
    expect(droppedTags()).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
  });
});
