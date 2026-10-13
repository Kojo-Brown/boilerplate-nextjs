import { describe, expect, it } from "vitest";
import {
  MAIN_CONTENT_ID,
  SKIP_LINK_HREF,
  decideRouteFocus,
  type RouteFocusInput,
} from "./route-focus";

/**
 * An ordinary forward navigation with nothing special about it. Each test
 * overrides the one field it is about, so a rule that starts depending on an
 * unrelated input fails here rather than passing by coincidence.
 */
function navigation(overrides: Partial<RouteFocusInput> = {}): RouteFocusInput {
  return {
    previousPathname: "/posts",
    pathname: "/settings/security",
    hash: "",
    isHistoryPop: false,
    isFocusOwned: false,
    hasRestorableTarget: false,
    ...overrides,
  };
}

describe("skip link target", () => {
  it("points the skip link at the landmark id", () => {
    expect(SKIP_LINK_HREF).toBe(`#${MAIN_CONTENT_ID}`);
  });
});

describe("decideRouteFocus", () => {
  it("focuses the landmark on a forward navigation", () => {
    expect(decideRouteFocus(navigation())).toEqual({
      action: "main",
      reason: "navigation",
    });
  });

  it("leaves focus alone on the first render", () => {
    // The browser has just focused the document itself and the screen reader
    // is reading the page that was asked for; moving the cursor to <main> here
    // skips the heading and the skip link.
    expect(decideRouteFocus(navigation({ previousPathname: null }))).toEqual({
      action: "keep",
      reason: "first-render",
    });
  });

  it("leaves focus alone when only the search params changed", () => {
    // `usePathname` reports the same value for /posts?page=1 and /posts?page=2.
    // Moving focus out of a paginator the visitor just operated is how that
    // control becomes unusable from the keyboard.
    expect(
      decideRouteFocus(
        navigation({ previousPathname: "/posts", pathname: "/posts" }),
      ),
    ).toEqual({ action: "keep", reason: "same-pathname" });
  });

  it("leaves focus alone when the URL carries a fragment", () => {
    expect(decideRouteFocus(navigation({ hash: "#comments" }))).toEqual({
      action: "keep",
      reason: "hash-target",
    });
  });

  it("yields to a component that manages focus itself", () => {
    expect(decideRouteFocus(navigation({ isFocusOwned: true }))).toEqual({
      action: "keep",
      reason: "focus-owned",
    });
  });

  it("restores the remembered element on a history pop", () => {
    expect(
      decideRouteFocus(
        navigation({ isHistoryPop: true, hasRestorableTarget: true }),
      ),
    ).toEqual({ action: "restore", reason: "history-pop" });
  });

  it("falls back to the landmark on a pop with nothing to restore", () => {
    expect(
      decideRouteFocus(
        navigation({ isHistoryPop: true, hasRestorableTarget: false }),
      ),
    ).toEqual({ action: "main", reason: "history-pop-without-target" });
  });

  it("does not restore on a forward navigation to a route seen before", () => {
    // The element is remembered and still in the document — but arriving at a
    // route is not returning to it, and focus belongs at the top of the new
    // content rather than wherever the visitor left off last time.
    expect(
      decideRouteFocus(
        navigation({ isHistoryPop: false, hasRestorableTarget: true }),
      ),
    ).toEqual({ action: "main", reason: "navigation" });
  });

  describe("precedence", () => {
    it("treats a search-param change as unchanged even on a pop", () => {
      // Back through a filter change is still an in-place update. Restoring
      // focus would be defensible; the rule that must not fire is `main`,
      // which would throw the visitor out of the control they were using.
      expect(
        decideRouteFocus(
          navigation({
            previousPathname: "/posts",
            pathname: "/posts",
            isHistoryPop: true,
            hasRestorableTarget: true,
          }),
        ),
      ).toEqual({ action: "keep", reason: "same-pathname" });
    });

    it("lets the browser's fragment handling win over a dialog claim", () => {
      expect(
        decideRouteFocus(navigation({ hash: "#top", isFocusOwned: true })),
      ).toEqual({ action: "keep", reason: "hash-target" });
    });

    it("lets a dialog claim win over a restore", () => {
      // Navigating forward into a modal from a route visited before: the
      // remembered element sits behind the overlay, and handing focus to it
      // would put the cursor in content `aria-modal` has just hidden.
      expect(
        decideRouteFocus(
          navigation({
            isFocusOwned: true,
            isHistoryPop: true,
            hasRestorableTarget: true,
          }),
        ),
      ).toEqual({ action: "keep", reason: "focus-owned" });
    });

    it("ignores every other input on the first render", () => {
      expect(
        decideRouteFocus({
          previousPathname: null,
          pathname: "/photos/ocean-at-sunset",
          hash: "#x",
          isHistoryPop: true,
          isFocusOwned: true,
          hasRestorableTarget: true,
        }),
      ).toEqual({ action: "keep", reason: "first-render" });
    });
  });
});
