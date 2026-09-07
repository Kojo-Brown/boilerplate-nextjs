import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
  refresh: vi.fn(),
}));

import { refresh, revalidateTag, updateTag } from "next/cache";
import { BLOG_POSTS_TAG, blogPostTag } from "@/lib/cache/tags";
import { dispatchOutboxEvent } from "./dispatch";
import type { OutboxEvent } from "./events";

const published: OutboxEvent = {
  type: "post.updated",
  payload: { postId: "post-1", wasPublished: false, isPublished: true },
};

const draft: OutboxEvent = {
  type: "post.created",
  payload: { postId: "post-1", published: false },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dispatchOutboxEvent", () => {
  it("uses updateTag in a Server Action, for read-your-own-writes", () => {
    // `revalidateTag` marks the entry stale and lets the *next* request refill
    // it, so the person who just clicked Publish could still be served the copy
    // they were trying to clear. That is the difference the context names.
    const tags = dispatchOutboxEvent(published, "server-action");

    expect(tags).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
    expect(vi.mocked(updateTag).mock.calls.map(([tag]) => tag)).toEqual([
      blogPostTag("post-1"),
      BLOG_POSTS_TAG,
    ]);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("uses revalidateTag in a route handler, which is the only one legal there", () => {
    // `updateTag` throws outside a Server Action (E872) and `refresh()` throws
    // for the same reason (E870) — and a test with `next/cache` mocked would
    // not notice, because the mock is what makes the throw go away. Asserting
    // which function was called is the only check available here.
    const tags = dispatchOutboxEvent(published, "route-handler");

    expect(tags).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
    expect(vi.mocked(revalidateTag).mock.calls).toEqual([
      [blogPostTag("post-1"), { expire: 0 }],
      [BLOG_POSTS_TAG, { expire: 0 }],
    ]);
    expect(updateTag).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("signals the client from a Server Action when no tag was dropped", () => {
    // A draft's mutation drops nothing, but the dashboard's uncached reads
    // still have to be re-read by the browser that submitted the action.
    expect(dispatchOutboxEvent(draft, "server-action")).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("has nothing to refresh from a route handler", () => {
    // There is no client to signal: the caller is a scheduler, not a browser
    // that is rendering something.
    expect(dispatchOutboxEvent(draft, "route-handler")).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
