import { act, render, screen, waitFor } from "@testing-library/react";
import { usePathname } from "next/navigation";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimFocusOwnership,
  resetFocusOwnershipForTests,
} from "@/lib/a11y/focus-ownership";
import { MAIN_CONTENT_ID } from "@/lib/a11y/route-focus";
import { MainContent } from "./main-content";
import { RouteFocus } from "./route-focus";

/**
 * A page with the two things a navigation has to choose between: a control in
 * persistent chrome, which is where focus is left when nothing manages it, and
 * the landmark it should end up on instead.
 *
 * Buttons rather than anchors, for the lint rule: an `<a href="/posts/1">` in
 * this repository is a route that should be a `<Link>`, and what these tests
 * need is only something focusable on either side of the landmark boundary.
 */
function Page({ children }: { children?: React.ReactNode }) {
  return (
    <>
      <button type="button">Settings</button>
      <MainContent>
        <h1>Heading</h1>
        <button type="button">First post</button>
      </MainContent>
      <RouteFocus />
      {children}
    </>
  );
}

/** Put the router on `pathname` and let the tree commit. */
async function navigateTo(pathname: string, rerender: () => void) {
  vi.mocked(usePathname).mockReturnValue(pathname);
  await act(async () => {
    rerender();
  });
}

/**
 * Commit a navigation without letting the deferred frame run yet.
 *
 * The seam that matters for Back: in a real browser Next's own `popstate`
 * listener is registered first and dispatches the router update from inside
 * it, so the commit lands *before* this component's listener is reached. A
 * test that sets the flag and then re-renders is testing the one order that
 * cannot happen.
 */
function commitNavigation(pathname: string, rerender: () => void) {
  vi.mocked(usePathname).mockReturnValue(pathname);
  act(() => {
    rerender();
  });
}

/** jsdom schedules `requestAnimationFrame` on a timer; let it run. */
async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

function main(): HTMLElement {
  const element = document.getElementById(MAIN_CONTENT_ID);
  if (!element) throw new Error("the landmark is missing");
  return element;
}

describe("<RouteFocus>", () => {
  beforeEach(() => {
    resetFocusOwnershipForTests();
    vi.mocked(usePathname).mockReturnValue("/posts");
  });

  afterEach(() => {
    window.location.hash = "";
  });

  it("leaves focus alone on the first render", async () => {
    render(<Page />);
    await nextFrame();

    // A full page load has already focused the document; stealing the cursor
    // here skips the heading the visitor asked to hear.
    expect(main()).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });

  it("focuses the landmark after a client-side navigation", async () => {
    const { rerender } = render(<Page />);
    await nextFrame();

    const link = screen.getByRole("button", { name: "Settings" });
    link.focus();
    expect(link).toHaveFocus();

    await navigateTo("/settings/security", () => rerender(<Page />));
    await waitFor(() => expect(main()).toHaveFocus());
  });

  it("does not move focus when only the search params changed", async () => {
    const { rerender } = render(<Page />);
    await nextFrame();

    const paginator = screen.getByRole("button", { name: "First post" });
    paginator.focus();

    // `usePathname` returns the same value for /posts?page=1 and ?page=2, so a
    // rerender is all a filter change looks like from here.
    await act(async () => {
      rerender(<Page />);
    });
    await nextFrame();

    expect(paginator).toHaveFocus();
  });

  it("does not move focus when the URL carries a fragment", async () => {
    const { rerender } = render(<Page />);
    await nextFrame();

    const link = screen.getByRole("button", { name: "Settings" });
    link.focus();
    window.location.hash = "#comments";

    await navigateTo("/blog/seed-post-cache-life", () => rerender(<Page />));
    await nextFrame();

    // The browser owns the fragment target. This rule is also what keeps the
    // skip link from being followed a frame later by a redundant focus move.
    expect(link).toHaveFocus();
  });

  it("yields to a dialog that manages its own focus", async () => {
    const { rerender } = render(<Page />);
    await nextFrame();

    const tile = screen.getByRole("button", { name: "First post" });
    tile.focus();

    // What `<PhotoModal>` does on mount, which is the frame this runs in.
    const release = claimFocusOwnership();

    await navigateTo("/photos/ocean-at-sunset", () => rerender(<Page />));
    await nextFrame();

    expect(main()).not.toHaveFocus();
    expect(tile).toHaveFocus();
    release();
  });

  it("returns focus to the element that was left behind on Back", async () => {
    const { rerender } = render(<Page />);
    await nextFrame();

    const tile = screen.getByRole("button", { name: "First post" });
    tile.focus();

    await navigateTo("/photos/ocean-at-sunset", () => rerender(<Page />));
    await waitFor(() => expect(main()).toHaveFocus());

    // `router.back()` — and the Back button — reach this component as a
    // `popstate` *after* the commit for the popped route: Next's listener is
    // registered first and React flushes a popstate update synchronously.
    commitNavigation("/posts", () => rerender(<Page />));
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => expect(tile).toHaveFocus());
  });

  it("still detects Back when the popstate arrives before the commit", async () => {
    // The other order, which is what a direct `history.back()` with no
    // framework listener in front of it produces. Both must work: the flag is
    // read in the deferred frame, which is after either of them.
    const { rerender } = render(<Page />);
    await nextFrame();

    const tile = screen.getByRole("button", { name: "First post" });
    tile.focus();

    await navigateTo("/pricing", () => rerender(<Page />));
    await waitFor(() => expect(main()).toHaveFocus());

    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await navigateTo("/posts", () => rerender(<Page />));

    await waitFor(() => expect(tile).toHaveFocus());
  });

  it("spends a pop signal on one navigation only", async () => {
    // Otherwise a Back press followed by a <Link> click would restore focus
    // to wherever the visitor had been on the destination, rather than
    // putting it at the top of content they are arriving at.
    const { rerender } = render(<Page />);
    await nextFrame();

    const tile = screen.getByRole("button", { name: "First post" });
    tile.focus();

    await navigateTo("/pricing", () => rerender(<Page />));
    await waitFor(() => expect(main()).toHaveFocus());

    commitNavigation("/posts", () => rerender(<Page />));
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(tile).toHaveFocus());

    // Forward again, no popstate this time.
    await navigateTo("/pricing", () => rerender(<Page />));
    await navigateTo("/posts", () => rerender(<Page />));

    await waitFor(() => expect(main()).toHaveFocus());
    expect(tile).not.toHaveFocus();
  });

  it("falls back to the landmark on a Back with nothing to restore", async () => {
    const { rerender } = render(<Page />);
    await nextFrame();

    // Nothing was ever focused on /pricing, so there is no remembered element
    // for it — the visitor arrived by Back from somewhere they had scrolled.
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await navigateTo("/pricing", () => rerender(<Page />));

    await waitFor(() => expect(main()).toHaveFocus());
  });

  it("does not restore on a forward navigation to a route seen before", async () => {
    const { rerender } = render(<Page />);
    await nextFrame();

    const tile = screen.getByRole("button", { name: "First post" });
    tile.focus();

    await navigateTo("/pricing", () => rerender(<Page />));
    await waitFor(() => expect(main()).toHaveFocus());

    // Back to /posts, this time by following a link rather than by Back.
    await navigateTo("/posts", () => rerender(<Page />));
    await waitFor(() => expect(main()).toHaveFocus());
    expect(tile).not.toHaveFocus();
  });

  it("renders no markup of its own", () => {
    const { container } = render(<RouteFocus />);
    expect(container).toBeEmptyDOMElement();
  });

  it("survives a route with no landmark rather than throwing", async () => {
    // A route that forgot `<MainContent>` is a gate failure, not a runtime
    // crash: `scripts/assert-focus-management.ts` is what fails the build, and
    // the visitor should still get a working page in the meantime.
    const { rerender } = render(<RouteFocus />);
    await nextFrame();

    await navigateTo("/forbidden", () => rerender(<RouteFocus />));
    await nextFrame();

    expect(document.activeElement).toBe(document.body);
  });

  it("stops listening when it unmounts", async () => {
    const addSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<Page />);
    await nextFrame();

    unmount();

    expect(addSpy).toHaveBeenCalledWith("focusin", expect.any(Function));
    addSpy.mockRestore();
  });
});
