// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import { PhotoModal } from "./photo-modal";

/**
 * `src/test/setup.ts` mocks `next/navigation` globally, but its `useRouter`
 * returns a fresh object of fresh spies on every call — so the instance the
 * component used is not the one a test could assert against. Pinning one
 * router per test is what makes `router.back()` observable.
 */
function mockRouter(): { back: ReturnType<typeof vi.fn> } {
  const back = vi.fn();
  vi.mocked(useRouter).mockReturnValue({
    back,
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  } as unknown as ReturnType<typeof useRouter>);
  return { back };
}

function renderModal() {
  const router = mockRouter();
  render(
    <PhotoModal title="Ocean at sunset" description="Breaking water.">
      <p>Photo body</p>
    </PhotoModal>,
  );
  return router;
}

describe("PhotoModal", () => {
  it("renders open with no trigger, because the URL is the trigger", () => {
    renderModal();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Ocean at sunset" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Photo body")).toBeInTheDocument();
  });

  it("navigates back on Escape rather than hiding itself", () => {
    // The distinction this asserts is the entire point of the component. Local
    // state would leave the address bar on /photos/<id> with nothing on
    // screen, and make the next Back press appear to do nothing.
    const { back } = renderModal();

    const event = new KeyboardEvent("keydown", { key: "Escape" });
    document.dispatchEvent(event);

    expect(back).toHaveBeenCalledTimes(1);
  });

  it("navigates back when the close button is used", async () => {
    const user = userEvent.setup();
    const { back } = renderModal();

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(back).toHaveBeenCalledTimes(1);
  });

  it("navigates back when the overlay is clicked", async () => {
    const user = userEvent.setup();
    const { back } = renderModal();

    const overlay = document.querySelector('[aria-hidden="true"]');
    expect(overlay).not.toBeNull();
    await user.click(overlay as Element);

    expect(back).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog so the keyboard lands somewhere useful", () => {
    renderModal();

    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  it("describes itself for screen readers with the caption", () => {
    renderModal();

    expect(screen.getByText("Breaking water.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("locks body scroll while open, so the gallery behind does not move", () => {
    renderModal();

    expect(document.body.style.overflow).toBe("hidden");
  });
});
