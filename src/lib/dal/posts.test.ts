import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    post: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import {
  getPublishedPosts,
  getPostsByUser,
  getPostById,
  getPostCountByUser,
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
  author: { id: "user-1", name: "Alice", email: "alice@example.com", image: null },
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
    expect(result[0].title).toBe("Hello World");
  });

  it("returns an empty array when no published posts exist", async () => {
    vi.mocked(prisma.post.findMany).mockResolvedValue([] as never);

    const result = await getPublishedPosts();
    expect(result).toEqual([]);
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
    expect(result[0].author.id).toBe("user-1");
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

describe("getPostCountByUser", () => {
  it("counts posts for a specific user", async () => {
    vi.mocked(prisma.post.count).mockResolvedValue(3);

    const count = await getPostCountByUser("user-1");

    expect(prisma.post.count).toHaveBeenCalledWith({ where: { authorId: "user-1" } });
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
