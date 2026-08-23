// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { draftMode } from "next/headers";
import { PreviewBanner } from "./preview-banner";

vi.mock("@/actions/preview", () => ({
  exitPreviewAction: vi.fn(),
}));

/**
 * An async Server Component. Testing Library renders the resolved element
 * rather than the component, which is why each case awaits the call first —
 * `render(<PreviewBanner … />)` would hand React a promise.
 */
const mockDraftMode = vi.mocked(draftMode);

function preview(isEnabled: boolean) {
  mockDraftMode.mockResolvedValue({
    isEnabled,
    enable: vi.fn(),
    disable: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof draftMode>>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PreviewBanner", () => {
  it("renders nothing for a public request", async () => {
    preview(false);

    const { container } = render(await PreviewBanner({ returnTo: "/blog" }));

    // Not merely hidden: the banner must leave no trace in the markup a public
    // reader receives, because that markup is what gets cached and shared.
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the draft session without interrupting the reader", async () => {
    preview(true);

    render(await PreviewBanner({ returnTo: "/blog" }));

    const banner = screen.getByTestId("preview-banner");
    expect(banner).toHaveTextContent(/draft mode/i);
    // `status`, not `alert`: an ambient condition, announced politely.
    expect(banner).toHaveAttribute("role", "status");
  });

  it("offers a way out that works without JavaScript", async () => {
    preview(true);

    render(await PreviewBanner({ returnTo: "/blog/post-1" }));

    // A real submit button in a real form — no click handler, so it works
    // before hydration, which for the control that exits a mode you did not
    // know you were in is the point.
    const button = screen.getByRole("button", { name: /exit preview/i });
    expect(button).toHaveAttribute("type", "submit");
    expect(button.closest("form")).not.toBeNull();
  });

  it("carries the caller's returnTo into the form", async () => {
    preview(true);

    const { container } = render(
      await PreviewBanner({ returnTo: "/blog/post-1" }),
    );

    const field = container.querySelector<HTMLInputElement>(
      'input[name="returnTo"]',
    );
    expect(field?.value).toBe("/blog/post-1");
  });
});
