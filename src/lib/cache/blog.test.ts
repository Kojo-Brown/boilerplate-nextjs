import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

vi.mock("@/lib/dal/posts", () => ({
  getPublishedPosts: vi.fn(),
  getPostsForPreview: vi.fn(),
  getPostById: vi.fn(),
  getPublishedPostById: vi.fn(),
}));

import { cacheLife, cacheTag } from "next/cache";
import { draftMode } from "next/headers";
import {
  getPostById,
  getPostsForPreview,
  getPublishedPostById,
  getPublishedPosts,
} from "@/lib/dal/posts";
import { BLOG_POSTS_TAG, blogPostTag } from "@/lib/cache/tags";
import {
  getBlogIndex,
  getBlogPost,
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
const mockGetPostsForPreview = vi.mocked(getPostsForPreview);
const mockGetPostById = vi.mocked(getPostById);
const mockGetPublishedPostById = vi.mocked(getPublishedPostById);
const mockDraftMode = vi.mocked(draftMode);

/** Puts the request in (or out of) a draft session. */
function preview(isEnabled: boolean) {
  mockDraftMode.mockResolvedValue({
    isEnabled,
    enable: vi.fn(),
    disable: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof draftMode>>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPublishedPosts.mockResolvedValue([]);
  mockGetPostsForPreview.mockResolvedValue([]);
  mockGetPostById.mockResolvedValue(null);
  mockGetPublishedPostById.mockResolvedValue(null);
  preview(false);
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

    expect(mockGetPublishedPostById).toHaveBeenNthCalledWith(1, "post-1");
    expect(mockGetPublishedPostById).toHaveBeenNthCalledWith(2, "post-2");
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

// The `blogPostTag` cases that used to close this file moved with the tag
// definitions themselves, to `src/lib/cache/tags.test.ts`.

/**
 * The draft-mode façade. These are the cases where getting it wrong is
 * expensive rather than merely wrong: a public request that reaches the preview
 * read is an unpublished-content leak, and a preview request that reaches the
 * cached read is both stale *and* liable to write a draft into an entry the
 * public shares.
 */
describe("getBlogIndex", () => {
  it("serves the cached published list to a public request", async () => {
    const published = [{ id: "p1" }] as unknown as Awaited<
      ReturnType<typeof getPublishedPosts>
    >;
    mockGetPublishedPosts.mockResolvedValue(published);

    const result = await getBlogIndex();

    expect(result.data).toBe(published);
    expect(mockGetPostsForPreview).not.toHaveBeenCalled();
    // The cached branch, so the entry is tagged and windowed as before.
    expect(mockCacheTag).toHaveBeenCalledExactlyOnceWith(BLOG_POSTS_TAG);
  });

  it("serves drafts too inside a preview", async () => {
    preview(true);
    const all = [{ id: "p1" }, { id: "draft" }] as unknown as Awaited<
      ReturnType<typeof getPostsForPreview>
    >;
    mockGetPostsForPreview.mockResolvedValue(all);

    const result = await getBlogIndex();

    expect(result.data).toBe(all);
    expect(mockGetPublishedPosts).not.toHaveBeenCalled();
  });

  it("never caches or tags the preview branch", async () => {
    // The property that keeps a draft out of the entry the public reads. Next
    // also refuses to save a cache entry in draft mode, but that is a framework
    // internal — this asserts the shape of our own code, which is what the
    // guarantee should rest on.
    preview(true);

    await getBlogIndex();

    expect(mockCacheTag).not.toHaveBeenCalled();
    expect(mockCacheLife).not.toHaveBeenCalled();
  });
});

describe("getBlogPost", () => {
  it("serves the cached post to a public request", async () => {
    await getBlogPost("post-1");

    expect(mockGetPublishedPostById).toHaveBeenCalledExactlyOnceWith("post-1");
    expect(mockCacheTag).toHaveBeenCalledExactlyOnceWith(
      BLOG_POSTS_TAG,
      blogPostTag("post-1"),
    );
  });

  it("reads the post uncached inside a preview", async () => {
    preview(true);
    const draftPost = {
      id: "post-1",
      published: false,
    } as unknown as Awaited<ReturnType<typeof getPostById>>;
    mockGetPostById.mockResolvedValue(draftPost);

    const result = await getBlogPost("post-1");

    expect(result.data).toBe(draftPost);
    expect(mockCacheTag).not.toHaveBeenCalled();
    expect(mockCacheLife).not.toHaveBeenCalled();
  });

  it("returns an unpublished post rather than hiding it, so the page can label it", async () => {
    preview(true);
    mockGetPostById.mockResolvedValue({
      id: "post-1",
      published: false,
    } as unknown as Awaited<ReturnType<typeof getPostById>>);

    const result = await getBlogPost("post-1");

    expect(result.data?.published).toBe(false);
  });
});

/**
 * The leak this feature very nearly shipped.
 *
 * `app/blog/[slug]/page.tsx` used to hold the published check itself
 * (`if (!post || !post.published) notFound()`). Draft mode required relaxing it
 * to `if (!post)`, which is correct only if the read applies the filter — and
 * for one commit it did not. A public request to an unpublished post's URL
 * answered 200 with its full contents. Every unit test passed;
 * `e2e/preview.spec.ts` caught it.
 *
 * These pin the invariant at the layer that now owns it, so the next person to
 * simplify `getCachedPost` back to `getPostById` fails here rather than in a
 * browser.
 */
describe("the public read cannot return an unpublished post", () => {
  it("getCachedPost reads through the published-only DAL function", async () => {
    await getCachedPost("post-1");

    expect(mockGetPublishedPostById).toHaveBeenCalledExactlyOnceWith("post-1");
    expect(mockGetPostById).not.toHaveBeenCalled();
  });

  it("getBlogPost never touches the unfiltered read outside a preview", async () => {
    // Belt and braces: the branch above plus the read below are the two ways an
    // unpublished post could reach a public reader, and neither is exercised.
    mockGetPostById.mockResolvedValue({
      id: "post-1",
      published: false,
    } as unknown as Awaited<ReturnType<typeof getPostById>>);

    const result = await getBlogPost("post-1");

    expect(mockGetPostById).not.toHaveBeenCalled();
    expect(result.data).toBeNull();
  });
});
