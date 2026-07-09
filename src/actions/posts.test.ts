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
  revalidatePath: vi.fn(),
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createPostAction, deletePostAction, togglePublishAction } from "./posts";

const mockSession = {
  user: { id: "user-1", name: "Alice", email: "alice@example.com" },
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
  vi.mocked(auth).mockResolvedValue(mockSession as never);
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
        data: expect.objectContaining({ title: "Hello World", authorId: "user-1" }),
      }),
    );
  });

  it("returns error when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null);

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
    vi.mocked(prisma.post.create).mockResolvedValue({ ...mockPost, content: "Some body" } as never);

    const result = await createPostAction({ title: "Post", content: "Some body" });

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
    vi.mocked(prisma.post.findUnique).mockResolvedValue({ authorId: "user-1" } as never);
    vi.mocked(prisma.post.delete).mockResolvedValue(mockPost as never);

    const result = await deletePostAction("post-1");

    expect(result.success).toBe(true);
    expect(prisma.post.delete).toHaveBeenCalledWith({ where: { id: "post-1" } });
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
    vi.mocked(prisma.post.findUnique).mockResolvedValue({ authorId: "user-2" } as never);

    const result = await deletePostAction("post-1");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("own posts");
    }
    expect(prisma.post.delete).not.toHaveBeenCalled();
  });

  it("returns error when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null);

    const result = await deletePostAction("post-1");

    expect(result.success).toBe(false);
    expect(prisma.post.delete).not.toHaveBeenCalled();
  });
});

describe("togglePublishAction", () => {
  it("toggles a draft post to published", async () => {
    vi.mocked(prisma.post.findUnique).mockResolvedValue({ authorId: "user-1", published: false } as never);
    vi.mocked(prisma.post.update).mockResolvedValue({ ...mockPost, published: true } as never);

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
    vi.mocked(prisma.post.findUnique).mockResolvedValue({ authorId: "user-1", published: true } as never);
    vi.mocked(prisma.post.update).mockResolvedValue({ ...mockPost, published: false } as never);

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
    vi.mocked(prisma.post.findUnique).mockResolvedValue({ authorId: "user-2", published: false } as never);

    const result = await togglePublishAction("post-1");

    expect(result.success).toBe(false);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });
});
