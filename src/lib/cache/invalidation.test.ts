import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
  refresh: vi.fn(),
}));

import { refresh, revalidateTag, updateTag } from "next/cache";
import { BLOG_POSTS_TAG, blogPostTag } from "@/lib/cache/tags";
import { invalidate, revalidateFromWebhook, tagsFor } from "./invalidation";
import type { CacheMutation } from "./invalidation";

const mockUpdateTag = vi.mocked(updateTag);
const mockRevalidateTag = vi.mocked(revalidateTag);
const mockRefresh = vi.mocked(refresh);

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * `tagsFor` is pure, so the policy is tested directly rather than through the
 * Next APIs. Every case here is a statement about what a reader of `/blog`
 * would see, not about which function was called.
 */
describe("tagsFor", () => {
  describe("post.created", () => {
    it("drops nothing for a draft", () => {
      // Posts are created unpublished. Nothing public changed, so purging the
      // blog would only throw away a warm cache entry.
      expect(
        tagsFor({ kind: "post.created", postId: "post-1", published: false }),
      ).toEqual([]);
    });

    it("drops the post and the list when a post is created published", () => {
      expect(
        tagsFor({ kind: "post.created", postId: "post-1", published: true }),
      ).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
    });
  });

  describe("post.updated", () => {
    it("drops nothing when a draft stays a draft", () => {
      expect(
        tagsFor({
          kind: "post.updated",
          postId: "post-1",
          wasPublished: false,
          isPublished: false,
        }),
      ).toEqual([]);
    });

    it("invalidates on publish", () => {
      expect(
        tagsFor({
          kind: "post.updated",
          postId: "post-1",
          wasPublished: false,
          isPublished: true,
        }),
      ).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
    });

    it("invalidates on unpublish", () => {
      // The case a "is it published now?" check gets wrong. Nothing about the
      // post is public any more, which is exactly why the cached page has to be
      // dropped — it is still serving one.
      expect(
        tagsFor({
          kind: "post.updated",
          postId: "post-1",
          wasPublished: true,
          isPublished: false,
        }),
      ).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
    });

    it("invalidates an edit to an already-published post", () => {
      expect(
        tagsFor({
          kind: "post.updated",
          postId: "post-1",
          wasPublished: true,
          isPublished: true,
        }),
      ).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
    });
  });

  describe("post.deleted", () => {
    it("drops nothing when the deleted post was a draft", () => {
      expect(
        tagsFor({
          kind: "post.deleted",
          postId: "post-1",
          wasPublished: false,
        }),
      ).toEqual([]);
    });

    it("drops the post and the list when the deleted post was published", () => {
      // Without this the page outlives the row: `/blog/[slug]` kept serving a
      // deleted post for the remainder of its 300-second window.
      expect(
        tagsFor({ kind: "post.deleted", postId: "post-1", wasPublished: true }),
      ).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
    });
  });

  it("drops the list for a manual refresh", () => {
    expect(tagsFor({ kind: "blog.manual-refresh" })).toEqual([BLOG_POSTS_TAG]);
  });

  it("scopes the per-post tag to the id", () => {
    const first = tagsFor({
      kind: "post.deleted",
      postId: "post-1",
      wasPublished: true,
    });
    const second = tagsFor({
      kind: "post.deleted",
      postId: "post-2",
      wasPublished: true,
    });

    expect(first).not.toEqual(second);
    expect(first).toContain(blogPostTag("post-1"));
    expect(second).toContain(blogPostTag("post-2"));
  });
});

describe("invalidate", () => {
  it("calls updateTag once per tag and returns them", () => {
    const tags = invalidate({
      kind: "post.updated",
      postId: "post-1",
      wasPublished: true,
      isPublished: false,
    });

    expect(tags).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
    expect(mockUpdateTag.mock.calls.map(([tag]) => tag)).toEqual([
      blogPostTag("post-1"),
      BLOG_POSTS_TAG,
    ]);
  });

  /**
   * The two signals are mutually exclusive on purpose. Next writes both through
   * the same `pathWasRevalidated` field, and `refresh()` assigns
   * `ActionDidRevalidateDynamicOnly` unconditionally — so calling it after
   * `updateTag` would downgrade the static half of the revalidation that was
   * just requested. These two tests are what stops that being "tidied" into an
   * unconditional call later.
   */
  it("does not call refresh when a tag was dropped", () => {
    invalidate({
      kind: "post.updated",
      postId: "post-1",
      wasPublished: true,
      isPublished: false,
    });

    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("calls refresh when no tag was dropped", () => {
    // Creating a draft changes no cached entry, but it does change what the
    // dashboard's uncached reads would return, and the client is holding a copy
    // of those. `revalidatePath("/posts")` used to signal that as a side effect.
    const tags = invalidate({
      kind: "post.created",
      postId: "post-1",
      published: false,
    });

    expect(tags).toEqual([]);
    expect(mockUpdateTag).not.toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalledOnce();
  });

  it("signals exactly one of the two for every mutation", () => {
    const mutations: CacheMutation[] = [
      { kind: "post.created", postId: "p", published: false },
      { kind: "post.created", postId: "p", published: true },
      {
        kind: "post.updated",
        postId: "p",
        wasPublished: false,
        isPublished: false,
      },
      {
        kind: "post.updated",
        postId: "p",
        wasPublished: false,
        isPublished: true,
      },
      {
        kind: "post.updated",
        postId: "p",
        wasPublished: true,
        isPublished: false,
      },
      {
        kind: "post.updated",
        postId: "p",
        wasPublished: true,
        isPublished: true,
      },
      { kind: "post.deleted", postId: "p", wasPublished: false },
      { kind: "post.deleted", postId: "p", wasPublished: true },
      { kind: "blog.manual-refresh" },
    ];

    for (const mutation of mutations) {
      vi.clearAllMocks();
      invalidate(mutation);

      const taggedCount = mockUpdateTag.mock.calls.length;
      const refreshedCount = mockRefresh.mock.calls.length;

      expect(
        taggedCount > 0 !== refreshedCount > 0,
        `${mutation.kind} signalled ${taggedCount} tag(s) and ${refreshedCount} refresh(es)`,
      ).toBe(true);
    }
  });
});

/**
 * The Route Handler entry point.
 *
 * Every assertion here is about a *runtime* constraint that a mocked
 * `next/cache` makes invisible: `updateTag` and `refresh` throw outside a
 * Server Action, and this suite's mock is precisely what stops them throwing.
 * So the tests check which function was called, not just which tags came back —
 * a webhook that reached for `updateTag` would return the right tags and 500 on
 * every real delivery.
 */
describe("revalidateFromWebhook", () => {
  it("drops the same tags the Server Action path would", () => {
    const mutation: CacheMutation = {
      kind: "post.updated",
      postId: "post-1",
      wasPublished: false,
      isPublished: true,
    };

    expect(revalidateFromWebhook(mutation)).toEqual(tagsFor(mutation));
  });

  it("uses revalidateTag, never updateTag", () => {
    revalidateFromWebhook({ kind: "blog.manual-refresh" });

    expect(mockRevalidateTag).toHaveBeenCalledOnce();
    expect(mockUpdateTag).not.toHaveBeenCalled();
  });

  it("expires the entry immediately rather than serving it stale", () => {
    // The profile argument is the whole difference between this and a
    // stale-while-revalidate drop. `"max"` would leave the old copy servable,
    // which would mean a publish through the CMS and a publish through the
    // dashboard reach readers at different times.
    revalidateFromWebhook({ kind: "blog.manual-refresh" });

    expect(mockRevalidateTag).toHaveBeenCalledWith(BLOG_POSTS_TAG, {
      expire: 0,
    });
  });

  it("never calls refresh, which throws outside a Server Action", () => {
    // The mutation that drops no tags is the one `invalidate` answers with
    // `refresh()`. There is no client holding uncached data here, and calling
    // it would be an E870 on every delivery.
    const tags = revalidateFromWebhook({
      kind: "post.created",
      postId: "post-1",
      published: false,
    });

    expect(tags).toEqual([]);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockRevalidateTag).not.toHaveBeenCalled();
  });

  it("drops every tag the policy names, in order", () => {
    const tags = revalidateFromWebhook({
      kind: "post.deleted",
      postId: "post-9",
      wasPublished: true,
    });

    expect(tags).toEqual([blogPostTag("post-9"), BLOG_POSTS_TAG]);
    expect(mockRevalidateTag.mock.calls.map(([tag]) => tag)).toEqual([
      blogPostTag("post-9"),
      BLOG_POSTS_TAG,
    ]);
  });
});
