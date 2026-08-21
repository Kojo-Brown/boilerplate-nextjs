import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    post: {
      create: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  refresh: vi.fn(),
}));

import type { Session } from "next-auth";
import { auth } from "@/auth";
import { updateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { BLOG_POSTS_TAG, blogPostTag } from "@/lib/cache/tags";
import {
  createPostAction,
  deletePostAction,
  togglePublishAction,
} from "./posts";

const mockUpdateTag = vi.mocked(updateTag);

/** The tags dropped by this action call, in order. */
function droppedTags(): string[] {
  return mockUpdateTag.mock.calls.map(([tag]) => tag);
}

// NextAuth v5's `auth` is overloaded (middleware, route wrapper, bare call).
// `vi.mocked` binds to the middleware overload, so narrow it to the no-argument
// form the server actions call before stubbing return values.
const mockAuth = vi.mocked(auth as () => Promise<Session | null>);

const mockSession: Session = {
  user: {
    id: "user-1",
    name: "Alice",
    email: "alice@example.com",
    role: "USER",
  },
  expires: "2099-01-01",
};

const mockPost = {
  id: "post-1",
  title: "Hello World",
  published: false,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  authorId: "user-1",
  author: { id: "user-1", name: "Alice", email: "alice@example.com" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(mockSession);
});

describe("createPostAction", () => {
  it("creates a post for the authenticated user", async () => {
    vi.mocked(prisma.post.create).mockResolvedValue(mockPost as never);

    const result = await createPostAction({ title: "Hello World" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("Hello World");
    }
    expect(prisma.post.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Hello World",
          authorId: "user-1",
        }),
      }),
    );
  });

  it("returns error when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await createPostAction({ title: "Test" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("signed in");
    }
    expect(prisma.post.create).not.toHaveBeenCalled();
  });

  it("returns field errors for empty title", async () => {
    const result = await createPostAction({ title: "" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fieldErrors).toBeDefined();
    }
    expect(prisma.post.create).not.toHaveBeenCalled();
  });

  it("creates a post with optional content", async () => {
    vi.mocked(prisma.post.create).mockResolvedValue({
      ...mockPost,
      content: "Some body",
    } as never);

    const result = await createPostAction({
      title: "Post",
      content: "Some body",
    });

    expect(result.success).toBe(true);
    expect(prisma.post.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ content: "Some body" }),
      }),
    );
  });
});

describe("deletePostAction", () => {
  it("deletes a post owned by the user", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
    } as never);
    vi.mocked(prisma.post.delete).mockResolvedValue(mockPost as never);

    const result = await deletePostAction("post-1");

    expect(result.success).toBe(true);
    expect(prisma.post.delete).toHaveBeenCalledWith({
      where: { id: "post-1" },
    });
  });

  it("returns error when post not found", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue(null);

    const result = await deletePostAction("missing");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Post not found.");
    }
    expect(prisma.post.delete).not.toHaveBeenCalled();
  });

  it("returns error when user does not own the post", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-2",
    } as never);

    const result = await deletePostAction("post-1");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("own posts");
    }
    expect(prisma.post.delete).not.toHaveBeenCalled();
  });

  it("returns error when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const result = await deletePostAction("post-1");

    expect(result.success).toBe(false);
    expect(prisma.post.delete).not.toHaveBeenCalled();
  });
});

describe("togglePublishAction", () => {
  it("toggles a draft post to published", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: false,
    } as never);
    vi.mocked(prisma.post.update).mockResolvedValue({
      ...mockPost,
      published: true,
    } as never);

    const result = await togglePublishAction("post-1");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.published).toBe(true);
    }
    expect(prisma.post.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { published: true } }),
    );
  });

  it("toggles a published post to draft", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: true,
    } as never);
    vi.mocked(prisma.post.update).mockResolvedValue({
      ...mockPost,
      published: false,
    } as never);

    const result = await togglePublishAction("post-1");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.published).toBe(false);
    }
  });

  it("returns error when post not found", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue(null);

    const result = await togglePublishAction("missing");

    expect(result.success).toBe(false);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it("returns error when user does not own the post", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-2",
      published: false,
    } as never);

    const result = await togglePublishAction("post-1");

    expect(result.success).toBe(false);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });
});

/**
 * What each mutation invalidates.
 *
 * These assertions did not exist before, and their absence is why the bug they
 * now cover survived: the suite checked that every action wrote the right row
 * and never that it told the cache. `revalidatePath("/posts")` was mocked, so
 * it was called, and it named a page whose reads are uncached — the public blog
 * kept serving a list without the post that had just been published.
 *
 * The policy itself is tested in `src/lib/cache/invalidation.test.ts`. These
 * cover the part only the action can get wrong: reporting the post's published
 * state accurately, and reporting it at all.
 */
describe("cache invalidation", () => {
  it("does not touch the blog cache when a draft is created", async () => {
    vi.mocked(prisma.post.create).mockResolvedValue(mockPost as never);

    await createPostAction({ title: "Hello World" });

    expect(droppedTags()).toEqual([]);
  });

  it("drops the blog cache when a post is created published", async () => {
    // Posts default to `published: false` today, so this exercises the flag
    // being read from the created row rather than assumed.
    vi.mocked(prisma.post.create).mockResolvedValue({
      ...mockPost,
      published: true,
    } as never);

    await createPostAction({ title: "Hello World" });

    expect(droppedTags()).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
  });

  it("drops the blog cache when a post is published", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: false,
    } as never);
    vi.mocked(prisma.post.update).mockResolvedValue({
      ...mockPost,
      published: true,
    } as never);

    await togglePublishAction("post-1");

    expect(droppedTags()).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
  });

  it("drops the blog cache when a post is unpublished", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: true,
    } as never);
    vi.mocked(prisma.post.update).mockResolvedValue({
      ...mockPost,
      published: false,
    } as never);

    await togglePublishAction("post-1");

    expect(droppedTags()).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
  });

  it("drops the blog cache when a published post is deleted", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: true,
    } as never);
    vi.mocked(prisma.post.delete).mockResolvedValue(mockPost as never);

    await deletePostAction("post-1");

    // The page outlived the row before this: `/blog/[slug]` kept serving a
    // deleted post until its 300-second window expired.
    expect(droppedTags()).toEqual([blogPostTag("post-1"), BLOG_POSTS_TAG]);
  });

  it("reads the published flag before deleting, not after", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: true,
    } as never);
    vi.mocked(prisma.post.delete).mockResolvedValue(mockPost as never);

    await deletePostAction("post-1");

    // The row is gone once `delete` returns, so the ownership lookup is the
    // only chance to learn whether the post was public. If that select ever
    // loses `published`, the delete silently stops invalidating anything.
    expect(prisma.post.findUnique).toHaveBeenCalledWith({
      where: { id: "post-1" },
      select: { authorId: true, published: true },
    });
  });

  it("does not touch the blog cache when a draft is deleted", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({
      authorId: "user-1",
      published: false,
    } as never);
    vi.mocked(prisma.post.delete).mockResolvedValue(mockPost as never);

    await deletePostAction("post-1");

    expect(droppedTags()).toEqual([]);
  });

  it("invalidates nothing when a mutation is rejected", async () => {
    // A rejected write must not purge a warm cache entry — otherwise an
    // unauthenticated caller can empty the blog cache on demand by looping a
    // delete they have no permission to perform.
    mockAuth.mockResolvedValue(null);

    await createPostAction({ title: "Hello" });
    await deletePostAction("post-1");
    await togglePublishAction("post-1");

    mockAuth.mockResolvedValue(mockSession);
    vi.mocked(prisma.post.findUnique).mockResolvedValue(null);

    await deletePostAction("missing");
    await togglePublishAction("missing");

    expect(mockUpdateTag).not.toHaveBeenCalled();
  });
});
