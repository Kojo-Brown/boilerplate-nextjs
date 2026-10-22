// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@/lib/toast";
import { CopyLinkButton } from "./copy-link-button";

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

/**
 * jsdom ships no clipboard, and `userEvent.setup()` installs a stub that
 * `navigator.clipboard` then resolves to. Both paths are stubbed explicitly so
 * the rejection case is a described behaviour rather than an accident of the
 * environment.
 */
function stubClipboard(writeText: () => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(writeText) },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("CopyLinkButton", () => {
  it("copies an absolute URL built from the current origin", async () => {
    // The point of copying rather than showing: the path alone is useless in a
    // chat window, and a hard-coded production origin is wrong on every
    // preview deployment.
    const user = userEvent.setup();
    stubClipboard(() => Promise.resolve());
    render(<CopyLinkButton path="/photos/ocean-at-sunset" />);

    await user.click(screen.getByRole("button", { name: "Copy link" }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/photos/ocean-at-sunset`,
    );
  });

  it("confirms the copy in the label and with a toast", async () => {
    const user = userEvent.setup();
    stubClipboard(() => Promise.resolve());
    render(<CopyLinkButton path="/photos/ocean-at-sunset" />);

    await user.click(screen.getByRole("button", { name: "Copy link" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copied" }),
      ).toBeInTheDocument(),
    );
    expect(toast.success).toHaveBeenCalledWith("Link copied");
  });

  it("tells the user where to find the link when the clipboard refuses", async () => {
    // `navigator.clipboard` is undefined outside a secure context and rejects
    // when the document is unfocused — a silent failure here would look like
    // a successful copy of nothing.
    const user = userEvent.setup();
    stubClipboard(() => Promise.reject(new Error("not allowed")));
    render(<CopyLinkButton path="/photos/ocean-at-sunset" />);

    await user.click(screen.getByRole("button", { name: "Copy link" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Copy link" }),
    ).toBeInTheDocument();
  });

  it("returns to the idle label after the confirmation window", async () => {
    // `fireEvent` inside `act`, not `userEvent`: userEvent's own waiting loop
    // and Vitest's fake clock deadlock each other, and the thing under test
    // here is a `setTimeout`, not an interaction. Awaiting the `act` flushes
    // the microtask the awaited `writeText` queues.
    vi.useFakeTimers();
    stubClipboard(() => Promise.resolve());
    render(<CopyLinkButton path="/photos/ocean-at-sunset" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(
      screen.getByRole("button", { name: "Copy link" }),
    ).toBeInTheDocument();
  });
});
