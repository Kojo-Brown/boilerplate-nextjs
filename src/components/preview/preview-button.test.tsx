// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createPreviewLinkAction } from "@/actions/preview";
import { toast } from "@/lib/toast";
import { PreviewButton } from "./preview-button";

vi.mock("@/actions/preview", () => ({
  createPreviewLinkAction: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  toastActionError: vi.fn(),
}));

const mockCreateLink = vi.mocked(createPreviewLinkAction);

/**
 * `window.location.assign` is not implemented in jsdom and cannot be spied on
 * where it sits, so it is replaced outright. That it is `assign` and not a
 * router push is the behaviour worth pinning: `/api/preview` answers with a
 * `Set-Cookie`, and only a document navigation commits one.
 */
const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "location", {
    value: { assign, href: "http://localhost/posts" },
    writable: true,
    configurable: true,
  });
});

function linkResult(url: string) {
  return {
    success: true as const,
    data: { url, expiresAt: new Date(Date.now() + 900_000).toISOString() },
  };
}

describe("PreviewButton", () => {
  it("mints the link on click, not on render", async () => {
    mockCreateLink.mockResolvedValue(
      linkResult("http://localhost/api/preview?token=t"),
    );

    render(<PreviewButton postId="post-1" />);

    // A token minted at render time would be a live capability sitting in the
    // DOM of a tab that might stay open all day.
    expect(mockCreateLink).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(mockCreateLink).toHaveBeenCalledExactlyOnceWith("post-1");
  });

  it("navigates to the minted URL with a document request", async () => {
    mockCreateLink.mockResolvedValue(
      linkResult("http://localhost/api/preview?token=abc"),
    );

    render(<PreviewButton postId="post-1" />);
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledExactlyOnceWith(
        "http://localhost/api/preview?token=abc",
      );
    });
  });

  it("does not navigate when the action refuses", async () => {
    mockCreateLink.mockResolvedValue({
      success: false,
      error: "That post does not exist, or you cannot preview it.",
    });

    render(<PreviewButton postId="post-1" />);
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => {
      expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
    });
    expect(assign).not.toHaveBeenCalled();
  });

  it("passes a caller's className through so it can match its toolbar", async () => {
    render(<PreviewButton postId="post-1" className="rounded-md border" />);

    expect(screen.getByRole("button", { name: "Preview" }).className).toBe(
      "rounded-md border",
    );
  });
});
