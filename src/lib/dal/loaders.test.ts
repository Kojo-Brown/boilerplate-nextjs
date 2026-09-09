import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findMany: vi.fn() },
    post: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { createPostLoader, createUserLoader } from "./loaders";

const mockUser = {
  id: "user-1",
  name: "Alice",
  email: "alice@example.com",
  image: null,
  role: "USER" as const,
  createdAt: new Date("2024-01-01"),
};

const mockPost = {
  id: "post-1",
  title: "Hello World",
  content: "Some content",
  published: true,
  version: 1,
  authorId: "user-1",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
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

describe("createUserLoader", () => {
  it("turns N reads of distinct ids into one keyed findMany", async () => {
    const second = { ...mockUser, id: "user-2", email: "bob@example.com" };
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      mockUser,
      second,
    ] as never);

    const loader = createUserLoader();
    const results = await Promise.all([
      loader.load("user-1"),
      loader.load("user-2"),
    ]);

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["user-1", "user-2"] } } }),
    );
    expect(results.map((u) => u?.id)).toEqual(["user-1", "user-2"]);
  });

  it("selects the profile fields and nothing else", async () => {
    // `password` lives on the same row. A loader that selected it would put a
    // hash one property access away from anything rendering a profile.
    vi.mocked(prisma.user.findMany).mockResolvedValue([mockUser] as never);

    await createUserLoader().load("user-1");

    const [args] = vi.mocked(prisma.user.findMany).mock.calls[0] ?? [];
    expect((args as { select: Record<string, boolean> }).select).toEqual({
      id: true,
      name: true,
      email: true,
      image: true,
      role: true,
      createdAt: true,
    });
  });

  it("resolves an id with no row as null", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);

    expect(await createUserLoader().load("nobody")).toBeNull();
  });
});

describe("createPostLoader", () => {
  it("turns N reads of distinct ids into one keyed findMany", async () => {
    const second = { ...mockPost, id: "post-2" };
    vi.mocked(prisma.post.findMany).mockResolvedValue([
      mockPost,
      second,
    ] as never);

    const loader = createPostLoader();
    const results = await Promise.all([
      loader.load("post-1"),
      loader.load("post-2"),
    ]);

    expect(prisma.post.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["post-1", "post-2"] } } }),
    );
    expect(results.map((p) => p?.id)).toEqual(["post-1", "post-2"]);
  });

  it("includes the author, so a list of posts is still one query", async () => {
    // The relation comes back with the row. Without it, rendering a byline per
    // post would be an N+1 the loader cannot help with — batching the posts
    // and then loading each author separately is the same number of round
    // trips one level down.
    vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

    await createPostLoader().load("post-1");

    const [args] = vi.mocked(prisma.post.findMany).mock.calls[0] ?? [];
    expect((args as { include: unknown }).include).toEqual({
      author: { select: { id: true, name: true, email: true, image: true } },
    });
  });

  it("gives each instance its own cache", async () => {
    // Two instances are two requests. If they shared anything, the second
    // request would be served rows read on behalf of the first one's user.
    vi.mocked(prisma.post.findMany).mockResolvedValue([mockPost] as never);

    await createPostLoader().load("post-1");
    await createPostLoader().load("post-1");

    expect(prisma.post.findMany).toHaveBeenCalledTimes(2);
  });
});
