import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
}));

import { updateTag } from "next/cache";
import { BLOG_POSTS_TAG, blogPostTag } from "@/lib/cache/blog";
import { revalidateBlogAction, revalidatePost } from "./blog";

const mockUpdateTag = vi.mocked(updateTag);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("revalidateBlogAction", () => {
  it("invalidates the published-post list for a known target", async () => {
    const result = await revalidateBlogAction("/blog");

    expect(result).toEqual({
      success: true,
      data: { path: "/blog", tags: [BLOG_POSTS_TAG] },
    });
    expect(mockUpdateTag).toHaveBeenCalledExactlyOnceWith(BLOG_POSTS_TAG);
  });

  it("rejects a target that is not on the allowlist", async () => {
    const result = await revalidateBlogAction("/admin");

    expect(result).toEqual({
      success: false,
      error: '"/admin" is not a revalidation target.',
    });
    expect(mockUpdateTag).not.toHaveBeenCalled();
  });

  it("invalidates nothing when the target is rejected", async () => {
    // The action is reachable by anyone who can reach the page, so an
    // arbitrary argument must not be able to name a cache tag.
    for (const target of ["", "/", "blog", "/blog/", "../blog", "blog:posts"]) {
      await revalidateBlogAction(target);
    }

    expect(mockUpdateTag).not.toHaveBeenCalled();
  });

  it("does not treat inherited Object properties as targets", async () => {
    // `Object.hasOwn` rather than `in` or a truthiness check: "constructor"
    // and "toString" are present on any plain object's prototype chain.
    const result = await revalidateBlogAction("constructor");

    expect(result.success).toBe(false);
    expect(mockUpdateTag).not.toHaveBeenCalled();
  });
});

describe("revalidatePost", () => {
  it("invalidates the post and the list it appears in", async () => {
    await revalidatePost("post-1");

    // Both, deliberately: the list caches a post's title, so dropping only the
    // post page would leave /blog showing the old one.
    expect(mockUpdateTag.mock.calls.map(([tag]) => tag)).toEqual([
      blogPostTag("post-1"),
      BLOG_POSTS_TAG,
    ]);
  });

  it("scopes the per-post tag to the id", async () => {
    await revalidatePost("post-1");
    await revalidatePost("post-2");

    expect(mockUpdateTag).toHaveBeenCalledWith(blogPostTag("post-1"));
    expect(mockUpdateTag).toHaveBeenCalledWith(blogPostTag("post-2"));
    expect(blogPostTag("post-1")).not.toBe(blogPostTag("post-2"));
  });
});
