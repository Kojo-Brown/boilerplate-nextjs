import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";

vi.mock("@/actions/posts", () => ({
  createPostAction: vi.fn(),
  deletePostAction: vi.fn(),
  togglePublishAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { createPostAction } from "@/actions/posts";
import { renderWithProviders } from "@/test/render";
import { CreatePostDialog } from "./create-post-dialog";

const mockCreatePostAction = vi.mocked(createPostAction);

const createdPost = {
  id: "post-1",
  title: "Hello World",
  published: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  author: { id: "user-1", name: "Grace Hopper", email: "grace@example.com" },
};

/** The idempotency keys the action was called with, in order. */
function keysUsed(): string[] {
  return mockCreatePostAction.mock.calls.map(([input]) => input.idempotencyKey);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreatePostAction.mockResolvedValue({ success: true, data: createdPost });
});

/** Opens the dialog and fills in a title. */
async function openAndFill(
  title: string,
): Promise<ReturnType<typeof renderWithProviders>> {
  const rendered = renderWithProviders(<CreatePostDialog />);

  await rendered.user.click(screen.getByRole("button", { name: "New Post" }));
  await rendered.user.type(screen.getByLabelText(/Title/), title);

  return rendered;
}

describe("CreatePostDialog", () => {
  it("sends an idempotency key with the submission", async () => {
    const { user } = await openAndFill("Hello World");

    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(mockCreatePostAction).toHaveBeenCalledTimes(1));
    expect(keysUsed()[0]).toEqual(expect.any(String));
    expect(keysUsed()[0]?.length).toBeGreaterThanOrEqual(16);
  });

  it("reuses the key when an identical submission is retried", async () => {
    // The property the whole mechanism rests on. A key minted inside the submit
    // handler would compile, read correctly, and deduplicate nothing — every
    // retry would look to the server like a second post someone wanted.
    mockCreatePostAction.mockResolvedValueOnce({
      success: false,
      error: "Network error",
    });

    const { user } = await openAndFill("Hello World");
    const create = screen.getByRole("button", { name: "Create" });

    await user.click(create);
    await waitFor(() => expect(mockCreatePostAction).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockCreatePostAction).toHaveBeenCalledTimes(2));

    const [first, second] = keysUsed();
    expect(second).toBe(first);
  });

  it("mints a fresh key when the retry carries different content", async () => {
    // Reusing a key for a changed payload is a conflict on the server, which
    // would be the right answer to the wrong question: the user edited their
    // post and resubmitted, and that is a new request.
    mockCreatePostAction.mockResolvedValueOnce({
      success: false,
      error: "Network error",
    });

    const { user } = await openAndFill("Hello World");

    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockCreatePostAction).toHaveBeenCalledTimes(1));

    await user.type(screen.getByLabelText(/Title/), " (revised)");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockCreatePostAction).toHaveBeenCalledTimes(2));

    const [first, second] = keysUsed();
    expect(second).not.toBe(first);
  });

  it("mints a fresh key for the next post after one succeeds", async () => {
    const { user } = await openAndFill("Hello World");

    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockCreatePostAction).toHaveBeenCalledTimes(1));

    // The dialog closes and clears itself on success, so this is a new post.
    // Carrying the key over would have the server replay the first one.
    await user.click(screen.getByRole("button", { name: "New Post" }));
    await user.type(screen.getByLabelText(/Title/), "A second post");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockCreatePostAction).toHaveBeenCalledTimes(2));

    const [first, second] = keysUsed();
    expect(second).not.toBe(first);
  });

  it("does not submit an empty title", async () => {
    const { user } = renderWithProviders(<CreatePostDialog />);

    await user.click(screen.getByRole("button", { name: "New Post" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(mockCreatePostAction).not.toHaveBeenCalled();
  });

  it("passes the content field through alongside the key", async () => {
    const { user } = await openAndFill("Hello World");

    await user.type(screen.getByLabelText("Content"), "Some body");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(mockCreatePostAction).toHaveBeenCalledTimes(1));
    expect(mockCreatePostAction).toHaveBeenCalledWith({
      idempotencyKey: expect.any(String),
      title: "Hello World",
      content: "Some body",
    });
  });
});
