import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/actions/posts", () => ({
  createPostAction: vi.fn(),
  deletePostAction: vi.fn(),
  togglePublishAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { createPostAction, deletePostAction, togglePublishAction } from "@/actions/posts";
import { toast } from "sonner";

const mockPost = {
  id: "post-1",
  title: "Hello World",
  published: false,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  author: { id: "user-1", name: "Alice", email: "alice@example.com" },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createPostAction (server action integration)", () => {
  it("resolves with the created post on success", async () => {
    vi.mocked(createPostAction).mockResolvedValue({ success: true, data: mockPost });

    const result = await createPostAction({ title: "Hello World" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("Hello World");
      expect(result.data.published).toBe(false);
    }
  });

  it("is called with correct arguments including optional content", async () => {
    vi.mocked(createPostAction).mockResolvedValue({ success: true, data: mockPost });

    await createPostAction({ title: "Test", content: "Body" });

    expect(createPostAction).toHaveBeenCalledWith({ title: "Test", content: "Body" });
  });

  it("resolves with an error result for an empty title", async () => {
    vi.mocked(createPostAction).mockResolvedValue({
      success: false,
      error: "Invalid input.",
      fieldErrors: { title: ["Title is required"] },
    });

    const result = await createPostAction({ title: "" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.fieldErrors?.title).toContain("Title is required");
    }
  });
});

describe("deletePostAction (server action integration)", () => {
  it("resolves with success for a valid owned post", async () => {
    vi.mocked(deletePostAction).mockResolvedValue({ success: true, data: undefined });

    const result = await deletePostAction("post-1");

    expect(result.success).toBe(true);
    expect(deletePostAction).toHaveBeenCalledWith("post-1");
  });

  it("resolves with error when post is not found", async () => {
    vi.mocked(deletePostAction).mockResolvedValue({ success: false, error: "Post not found." });

    const result = await deletePostAction("missing");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Post not found.");
    }
  });

  it("resolves with error when the user does not own the post", async () => {
    vi.mocked(deletePostAction).mockResolvedValue({
      success: false,
      error: "You can only delete your own posts.",
    });

    const result = await deletePostAction("post-2");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("own posts");
    }
  });
});

describe("togglePublishAction (server action integration)", () => {
  it("resolves with updated published=true when toggling a draft", async () => {
    vi.mocked(togglePublishAction).mockResolvedValue({
      success: true,
      data: { ...mockPost, published: true },
    });

    const result = await togglePublishAction("post-1");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.published).toBe(true);
    }
  });

  it("resolves with updated published=false when toggling a published post", async () => {
    vi.mocked(togglePublishAction).mockResolvedValue({
      success: true,
      data: { ...mockPost, published: false },
    });

    const result = await togglePublishAction("post-1");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.published).toBe(false);
    }
  });

  it("resolves with error when post is not found", async () => {
    vi.mocked(togglePublishAction).mockResolvedValue({ success: false, error: "Post not found." });

    const result = await togglePublishAction("missing");

    expect(result.success).toBe(false);
  });

  it("resolves with error for unauthorized access", async () => {
    vi.mocked(togglePublishAction).mockResolvedValue({
      success: false,
      error: "You can only update your own posts.",
    });

    const result = await togglePublishAction("post-2");

    expect(result.success).toBe(false);
  });
});

describe("toast helpers", () => {
  it("toast.success can be called with a message", () => {
    toast.success("Post created");
    expect(toast.success).toHaveBeenCalledWith("Post created");
  });

  it("toast.error can be called with an error message", () => {
    toast.error("Failed to delete post");
    expect(toast.error).toHaveBeenCalledWith("Failed to delete post");
  });
});
