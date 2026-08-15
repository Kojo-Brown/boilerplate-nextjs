import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

vi.mock("@/lib/dal/posts", () => ({
  getPublishedPosts: vi.fn(),
  getPostById: vi.fn(),
}));

import { cacheLife, cacheTag } from "next/cache";
import { getPostById, getPublishedPosts } from "@/lib/dal/posts";
import {
  BLOG_POSTS_TAG,
  blogPostTag,
  getCachedPost,
  getCachedPublishedPosts,
} from "./blog";

/**
 * `"use cache"` is a directive Next's compiler acts on; under Vitest it is an
 * inert string literal, so these functions run as ordinary async functions and
 * the `cacheLife`/`cacheTag` calls are observable. That is exactly the part
 * worth asserting: the tags and windows are the contract `@/actions/blog`
 * invalidates against, and a typo in either silently stops invalidation
 * working while every page still renders.
 */
const mockCacheLife = vi.mocked(cacheLife);
const mockCacheTag = vi.mocked(cacheTag);
const mockGetPublishedPosts = vi.mocked(getPublishedPosts);
const mockGetPostById = vi.mocked(getPostById);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPublishedPosts.mockResolvedValue([]);
  mockGetPostById.mockResolvedValue(null);
});

describe("getCachedPublishedPosts", () => {
  it("tags the entry so revalidateBlogAction can drop it", async () => {
    await getCachedPublishedPosts();

    expect(mockCacheTag).toHaveBeenCalledExactlyOnceWith(BLOG_POSTS_TAG);
  });

  it("carries the 60s window that `export const revalidate = 60` used to declare", async () => {
    await getCachedPublishedPosts();

    expect(mockCacheLife).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ revalidate: 60 }),
    );
  });

  it("lets a client reuse its copy for less time than the server cache", async () => {
    await getCachedPublishedPosts();

    const [profile] = mockCacheLife.mock.calls[0] ?? [];
    expect(profile).toMatchObject({ stale: expect.any(Number) });
    const { stale, revalidate } = profile as {
      stale: number;
      revalidate: number;
    };
    expect(stale).toBeLessThan(revalidate);
  });

  it("returns the DAL's posts alongside the moment the entry was filled", async () => {
    const posts = [{ id: "p1" }] as unknown as Awaited<
      ReturnType<typeof getPublishedPosts>
    >;
    mockGetPublishedPosts.mockResolvedValue(posts);

    const result = await getCachedPublishedPosts();

    expect(result.data).toBe(posts);
    expect(result.renderedAt).toBeInstanceOf(Date);
  });
});

describe("getCachedPost", () => {
  it("tags the entry with both the list and the post", async () => {
    await getCachedPost("post-1");

    // Two tags, so publishing can drop the list and an edit can drop one post.
    expect(mockCacheTag).toHaveBeenCalledExactlyOnceWith(
      BLOG_POSTS_TAG,
      blogPostTag("post-1"),
    );
  });

  it("carries the 300s window that `export const revalidate = 300` used to declare", async () => {
    await getCachedPost("post-1");

    expect(mockCacheLife).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ revalidate: 300 }),
    );
  });

  it("keys the cache entry on the id it was asked for", async () => {
    await getCachedPost("post-1");
    await getCachedPost("post-2");

    expect(mockGetPostById).toHaveBeenNthCalledWith(1, "post-1");
    expect(mockGetPostById).toHaveBeenNthCalledWith(2, "post-2");
    expect(mockCacheTag).toHaveBeenNthCalledWith(
      2,
      BLOG_POSTS_TAG,
      blogPostTag("post-2"),
    );
  });

  it("stamps a missing post too, so the page can render a 404 without a dynamic read", async () => {
    const result = await getCachedPost("nope");

    expect(result.data).toBeNull();
    expect(result.renderedAt).toBeInstanceOf(Date);
  });
});

describe("blogPostTag", () => {
  it("namespaces the tag so it cannot collide with the list tag", () => {
    expect(blogPostTag("post-1")).not.toBe(BLOG_POSTS_TAG);
    expect(blogPostTag("post-1")).toContain("post-1");
  });

  it("is a pure function of the id", () => {
    expect(blogPostTag("post-1")).toBe(blogPostTag("post-1"));
    expect(blogPostTag("a")).not.toBe(blogPostTag("b"));
  });
});
