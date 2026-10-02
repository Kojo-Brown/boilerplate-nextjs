// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { cookies, draftMode } from "next/headers";
import { PREVIEW_SCOPE_COOKIE, signPreviewScope } from "@/lib/preview/scope";
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

async function preview(isEnabled: boolean, { scoped = true } = {}) {
  mockDraftMode.mockResolvedValue({
    isEnabled,
    enable: vi.fn(),
    disable: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof draftMode>>);

  const value = scoped ? await signPreviewScope("tenant-mock-a") : undefined;
  vi.mocked(cookies).mockResolvedValue({
    get: vi.fn((name: string) =>
      name === PREVIEW_SCOPE_COOKIE && value !== undefined
        ? { name, value }
        : undefined,
    ),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PreviewBanner", () => {
  it("renders nothing for a public request", async () => {
    await preview(false);

    const { container } = render(await PreviewBanner({ returnTo: "/blog" }));

    // Not merely hidden: the banner must leave no trace in the markup a public
    // reader receives, because that markup is what gets cached and shared.
    expect(container).toBeEmptyDOMElement();
  });

  it("announces the draft session without interrupting the reader", async () => {
    await preview(true);

    render(await PreviewBanner({ returnTo: "/blog" }));

    const banner = screen.getByTestId("preview-banner");
    expect(banner).toHaveTextContent(/draft mode/i);
    // `status`, not `alert`: an ambient condition, announced politely.
    expect(banner).toHaveAttribute("role", "status");
  });

  it("offers a way out that works without JavaScript", async () => {
    await preview(true);

    render(await PreviewBanner({ returnTo: "/blog/post-1" }));

    // A real submit button in a real form — no click handler, so it works
    // before hydration, which for the control that exits a mode you did not
    // know you were in is the point.
    const button = screen.getByRole("button", { name: /exit preview/i });
    expect(button).toHaveAttribute("type", "submit");
    expect(button.closest("form")).not.toBeNull();
  });

  it("says the content is unpublished only when the session can read some", async () => {
    await preview(true);

    render(await PreviewBanner({ returnTo: "/blog" }));

    // `\u2019`, because the component ships `&rsquo;` — matching on a typewriter
    // apostrophe would pass only until somebody fixed the punctuation.
    expect(screen.getByTestId("preview-banner")).toHaveTextContent(
      /seeing this workspace\u2019s unpublished content/i,
    );
  });

  it("still renders, and says so, when the draft session has no workspace", async () => {
    // The reason this component reads the session and not the scope. The data
    // layer fails closed here and serves the published site; if the banner
    // failed closed too, the reader would be in draft mode with no "Exit
    // preview" button — a mode with no way out. So it appears, and tells the
    // truth about what is on the page.
    await preview(true, { scoped: false });

    render(await PreviewBanner({ returnTo: "/blog" }));

    const banner = screen.getByTestId("preview-banner");
    expect(banner).toHaveTextContent(/unscoped/i);
    expect(banner).toHaveTextContent(/seeing the published site/i);
    expect(banner).not.toHaveTextContent(/unpublished content/i);
    expect(
      screen.getByRole("button", { name: /exit preview/i }),
    ).toBeInTheDocument();
  });

  it("carries the caller's returnTo into the form", async () => {
    await preview(true);

    const { container } = render(
      await PreviewBanner({ returnTo: "/blog/post-1" }),
    );

    const field = container.querySelector<HTMLInputElement>(
      'input[name="returnTo"]',
    );
    expect(field?.value).toBe("/blog/post-1");
  });
});
