import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    post: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import {
  getPublishedPosts,
  getPostsForPreview,
  getPostsByUser,
  getPostById,
  getPublishedPostById,
  getPostCountByUser,
  getEditablePost,
  getPaginatedPostsByUser,
  getPaginatedPublishedPosts,
} from "./posts";

const mockPost = {
  id: "post-1",
  title: "Hello World",
  published: true,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  author: { id: "user-1", name: "Alice", email: "alice@example.com" },
};

const mockFullPost = {
  ...mockPost,
  content: "Some content",
  authorId: "user-1",
  author: {
    id: "user-1",
    name: "Alice",
    email: "alice@example.com",
    image: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getPublishedPosts", () => {
  it("queries published posts ordered by createdAt desc", async () => {
    vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

    const result = await getPublishedPosts();

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { published: true },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("Hello World");
  });

  it("returns an empty array when no published posts exist", async () => {
    vi.mocked(prisma.post.findMany).mockResolvedValue([] as never);

    const result = await getPublishedPosts();
    expect(result).toEqual([]);
  });
});

describe("getPostsForPreview", () => {
  it("applies no published filter, which is the whole reason it is separate", async () => {
    vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

    await getPostsForPreview();

    const [args] = vi.mocked(prisma.post.findMany).mock.calls[0] ?? [];
    // Not `where: { published: true }`, and not a `where` at all — an omitted
    // filter is the only shape that cannot be half-right.
    expect(args).not.toHaveProperty("where");
    expect(args).toMatchObject({ orderBy: { createdAt: "desc" } });
  });

  it("orders newest first, like the published list it stands in for", async () => {
    vi.mocked(prisma.post.findMany).mockResolvedValue([] as never);

    await getPostsForPreview();

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" } }),
    );
  });

  it("selects the same fields as the published list", async () => {
    // The two feed one component. A field present in one and not the other is
    // a preview that renders differently from the page it is previewing.
    vi.mocked(prisma.post.findMany).mockResolvedValue([] as never);

    await getPublishedPosts();
    await getPostsForPreview();

    const [published] = vi.mocked(prisma.post.findMany).mock.calls[0] ?? [];
    const [preview] = vi.mocked(prisma.post.findMany).mock.calls[1] ?? [];
    expect((preview as { select: unknown }).select).toEqual(
      (published as { select: unknown }).select,
    );
  });
});

describe("getPostsByUser", () => {
  it("filters posts by authorId", async () => {
    vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

    await getPostsByUser("user-1");

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { authorId: "user-1" },
      }),
    );
  });

  it("returns posts for the given user", async () => {
    vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

    const result = await getPostsByUser("user-1");
    expect(result).toHaveLength(1);
    expect(result[0]?.author.id).toBe("user-1");
  });
});

describe("getPostById", () => {
  it("looks up by primary key", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue(mockFullPost as never);

    const result = await getPostById("post-1");

    expect(prisma.post.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "post-1" } }),
    );
    expect(result?.id).toBe("post-1");
  });

  it("returns null when post does not exist", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue(null);

    const result = await getPostById("missing");
    expect(result).toBeNull();
  });
});

describe("getPublishedPostById", () => {
  it("puts the published filter in the query, not in the caller", async () => {
    vi.mocked(prisma.post.findFirst).mockResolvedValue(mockFullPost as never);

    await getPublishedPostById("post-1");

    // The regression this function exists for: while the check lived in the
    // page component, `getCachedPost` could write an unpublished post into a
    // cache entry the whole public shares.
    expect(prisma.post.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "post-1", published: true } }),
    );
  });

  it("returns null for an unpublished post", async () => {
    // The database applies the filter, so an unpublished row simply does not
    // come back. This pins the contract callers rely on.
    vi.mocked(prisma.post.findFirst).mockResolvedValue(null as never);

    expect(await getPublishedPostById("draft-1")).toBeNull();
  });

  it("includes the same author fields as getPostById", async () => {
    // The two feed one page. A narrower author here would render a byline that
    // differs between the preview and the published view.
    vi.mocked(prisma.post.findUnique).mockResolvedValue(mockFullPost as never);
    vi.mocked(prisma.post.findFirst).mockResolvedValue(mockFullPost as never);

    await getPostById("post-1");
    await getPublishedPostById("post-1");

    const [unfiltered] = vi.mocked(prisma.post.findUnique).mock.calls[0] ?? [];
    const [filtered] = vi.mocked(prisma.post.findFirst).mock.calls[0] ?? [];
    expect((filtered as { include: unknown }).include).toEqual(
      (unfiltered as { include: unknown }).include,
    );
  });
});

describe("getPostCountByUser", () => {
  it("counts posts for a specific user", async () => {
    vi.mocked(prisma.post.count).mockResolvedValue(3);

    const count = await getPostCountByUser("user-1");

    expect(prisma.post.count).toHaveBeenCalledWith({
      where: { authorId: "user-1" },
    });
    expect(count).toBe(3);
  });
});

describe("getPaginatedPostsByUser", () => {
  it("fetches take=limit+1 posts for cursor detection", async () => {
    vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

    await getPaginatedPostsByUser("user-1", { limit: 10 });

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 11, where: { authorId: "user-1" } }),
    );
  });

  it("passes cursor and skip when cursor is provided", async () => {
    vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

    await getPaginatedPostsByUser("user-1", { cursor: "post-1", limit: 5 });

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: "post-1" }, skip: 1, take: 6 }),
    );
  });

  it("returns hasMore=true and nextCursor when more items exist", async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      ...mockPost,
      id: `post-${i + 1}`,
    }));
    vi.mocked(prisma.post.findMany).mockResolvedValue(items as never);

    const page = await getPaginatedPostsByUser("user-1", { limit: 5 });

    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("post-5");
    expect(page.items).toHaveLength(5);
  });

  it("returns hasMore=false when on last page", async () => {
    vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

    const page = await getPaginatedPostsByUser("user-1", { limit: 10 });

    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});

describe("getPaginatedPublishedPosts", () => {
  it("filters by published=true", async () => {
    vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

    await getPaginatedPublishedPosts({ limit: 10 });

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { published: true } }),
    );
  });

  it("returns paginated results", async () => {
    const items = Array.from({ length: 4 }, (_, i) => ({
      ...mockPost,
      id: `post-${i + 1}`,
    }));
    vi.mocked(prisma.post.findMany).mockResolvedValue(items as never);

    const page = await getPaginatedPublishedPosts({ limit: 10 });

    expect(page.items).toHaveLength(4);
    expect(page.hasMore).toBe(false);
  });
});

describe("getEditablePost", () => {
  it("filters on the author in the query, not in the caller", async () => {
    vi.mocked(prisma.post.findFirst).mockResolvedValue(mockFullPost as never);

    await getEditablePost("post-1", "user-1");

    // The ownership rule is the `where`. A read that returned the row and left
    // the check to the page is one `||` away from serving another author's
    // draft — the same failure `getPublishedPostById` was written to close.
    expect(prisma.post.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "post-1", authorId: "user-1" },
      }),
    );
  });

  it("selects the editable fields and nothing else", async () => {
    vi.mocked(prisma.post.findFirst).mockResolvedValue(mockFullPost as never);

    await getEditablePost("post-1", "user-1");

    expect(prisma.post.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          id: true,
          title: true,
          content: true,
          published: true,
          updatedAt: true,
        },
      }),
    );
  });

  it("returns null when the post is not this user's", async () => {
    vi.mocked(prisma.post.findFirst).mockResolvedValue(null);

    await expect(getEditablePost("post-1", "user-2")).resolves.toBeNull();
  });
});
