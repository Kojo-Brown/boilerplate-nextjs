import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/outbox/store", () => ({
  prismaOutboxStore: {
    claim: vi.fn(),
    markProcessed: vi.fn(),
    retryLater: vi.fn(),
    markFailed: vi.fn(),
  },
  sweepProcessedEvents: vi.fn(),
}));

import { NextRequest } from "next/server";
import { revalidateTag, updateTag } from "next/cache";
import { isApiErrorBody } from "@/lib/api/errors";
import { BLOG_POSTS_TAG, blogPostTag } from "@/lib/cache/tags";
import { prismaOutboxStore, sweepProcessedEvents } from "@/lib/outbox/store";
import {
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
  signWebhookPayload,
} from "@/lib/webhooks/signature";
import { POST } from "./route";
import type { OutboxRelayPayload } from "./route";

/**
 * The relay endpoint.
 *
 * The store is mocked and the signer is not, for the reason
 * `revalidate/route.test.ts` gives: a mocked signer would let every case here
 * pass against a handler that never verified anything, while a real store would
 * only be testing Prisma.
 *
 * `next/cache` is mocked, which is the limitation worth naming again: the mock
 * is what makes `revalidateTag` callable outside a request context at all. So
 * these tests prove the handler dispatches through the route-handler path and
 * drops the right tags; they cannot prove Next accepts the call. The claim they
 * cannot make is the one that is false for `updateTag` (E872), which is exactly
 * why the dispatch context is a parameter rather than a default.
 */
const claim = vi.mocked(prismaOutboxStore.claim);
const markProcessed = vi.mocked(prismaOutboxStore.markProcessed);
const sweep = vi.mocked(sweepProcessedEvents);

beforeEach(() => {
  vi.clearAllMocks();
  claim.mockResolvedValue([]);
  sweep.mockResolvedValue(0);
});

async function post(body: string, header?: string | null): Promise<Response> {
  const signature =
    header === undefined ? await signWebhookPayload(body) : header;

  return POST(
    new NextRequest(
      new Request("https://example.test/api/outbox", {
        method: "POST",
        body,
        ...(signature !== null && {
          headers: { [SIGNATURE_HEADER]: signature },
        }),
      }),
    ),
  );
}

async function errorCode(response: Response): Promise<string> {
  const body: unknown = await response.json();
  return isApiErrorBody(body) ? body.error.code : "not-an-error-envelope";
}

describe("authentication", () => {
  it("refuses an unsigned request", async () => {
    const response = await post("{}", null);

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("unauthorized");
    // Nothing was claimed, so an unauthenticated caller cannot make the server
    // do the relay's work in a loop.
    expect(claim).not.toHaveBeenCalled();
  });

  it("refuses a signature over a different body", async () => {
    const response = await post("{}", await signWebhookPayload('{"limit":1}'));

    expect(response.status).toBe(401);
    expect(claim).not.toHaveBeenCalled();
  });

  it("tells an integrator when their clock is the problem", async () => {
    const stale = await signWebhookPayload("{}", {
      now: new Date(Date.now() - (SIGNATURE_TOLERANCE_SECONDS + 60) * 1000),
    });

    const response = await post("{}", stale);

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("clock");
  });

  it("verifies before it parses", async () => {
    // Ordering, so an unauthenticated caller cannot tell a malformed payload
    // from a well-formed one by the answer it gets.
    const response = await post("not json", null);

    expect(response.status).toBe(401);
  });
});

describe("the request body", () => {
  it("accepts an empty object and uses the defaults", async () => {
    const response = await post("{}");

    expect(response.status).toBe(200);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim.mock.calls[0]?.[0]?.limit).toBe(50);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await post("not json");

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("bad_request");
  });

  it("rejects a limit above the ceiling", async () => {
    // The batch is dispatched inside one request, so an unbounded limit is a
    // request that times out halfway through with its rows claimed.
    const response = await post(JSON.stringify({ limit: 100_000 }));

    expect(response.status).toBe(422);
    expect(claim).not.toHaveBeenCalled();
  });

  it("passes a valid limit through", async () => {
    await post(JSON.stringify({ limit: 5 }));

    expect(claim.mock.calls[0]?.[0]?.limit).toBe(5);
  });
});

describe("relaying", () => {
  it("dispatches a claimed event through the route-handler path", async () => {
    claim.mockResolvedValue([
      {
        id: "row-1",
        type: "post.updated",
        payload: { postId: "post-1", wasPublished: true, isPublished: false },
        attempts: 0,
      },
    ]);

    const response = await post("{}");
    const body = (await response.json()) as OutboxRelayPayload;

    expect(body).toMatchObject({ claimed: 1, processed: 1, deadLettered: 0 });
    expect(body.tags).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
    expect(markProcessed).toHaveBeenCalledTimes(1);

    // `revalidateTag`, not `updateTag`: the latter throws in a route handler.
    expect(vi.mocked(revalidateTag)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(updateTag)).not.toHaveBeenCalled();
  });

  it("reports an empty pass as evidence rather than a heartbeat", async () => {
    const body = (await (await post("{}")).json()) as OutboxRelayPayload;

    expect(body).toMatchObject({
      claimed: 0,
      processed: 0,
      retried: 0,
      deadLettered: 0,
      tags: [],
      failures: [],
    });
    expect(body.swept).toBeUndefined();
  });

  it("reports a dead letter with its reason", async () => {
    claim.mockResolvedValue([
      { id: "row-1", type: "post.exploded", payload: {}, attempts: 0 },
    ]);

    const body = (await (await post("{}")).json()) as OutboxRelayPayload;

    expect(body).toMatchObject({ claimed: 1, processed: 0, deadLettered: 1 });
    expect(body.failures[0]).toMatchObject({
      id: "row-1",
      deadLettered: true,
    });
    expect(body.failures[0]?.error).toContain("Unreadable payload");
  });

  it("sweeps only when asked to", async () => {
    sweep.mockResolvedValue(7);

    const body = (await (
      await post(JSON.stringify({ sweep: true }))
    ).json()) as OutboxRelayPayload;

    expect(body.swept).toBe(7);
    const [cutoff] = sweep.mock.calls[0] ?? [];
    expect(cutoff && Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(
      24 * 60 * 60 * 1000 - 5_000,
    );
  });
});
