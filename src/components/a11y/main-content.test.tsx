import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MAIN_CONTENT_ID } from "@/lib/a11y/route-focus";
import { MainContent } from "./main-content";

describe("<MainContent>", () => {
  it("renders a main landmark carrying the skip link's id", () => {
    render(<MainContent>body</MainContent>);
    const main = screen.getByRole("main");

    expect(main).toHaveAttribute("id", MAIN_CONTENT_ID);
    expect(main).toHaveTextContent("body");
  });

  it("is focusable programmatically without entering the tab order", () => {
    // Both halves matter. Without `tabindex="-1"` the skip link scrolls the
    // element into view and leaves focus on <body>, so the next Tab goes back
    // to the header — the most common way a skip link ships broken. A
    // positive value would instead put a whole page region into the tab
    // sequence ahead of the controls in it.
    render(<MainContent>body</MainContent>);
    const main = screen.getByRole("main");

    expect(main).toHaveAttribute("tabindex", "-1");

    main.focus();
    expect(main).toHaveFocus();
  });

  it("shows a focus ring only for keyboard focus", () => {
    // Every mouse-driven navigation focuses this element too, and an outline
    // drawn around the page content on every click is what gets the whole
    // rule deleted — along with the keyboard case that needs it.
    render(<MainContent>body</MainContent>);
    const className = screen.getByRole("main").className;

    expect(className).toMatch(/focus-visible:outline-2/);
    expect(className).not.toMatch(/(^|\s)focus:outline-2/);
  });

  it("keeps a caller's classes", () => {
    render(<MainContent className="flex-1 px-4">body</MainContent>);
    expect(screen.getByRole("main")).toHaveClass("flex-1", "px-4");
  });

  it("forwards the rest of a main element's props", () => {
    render(<MainContent aria-label="Search results">body</MainContent>);
    expect(screen.getByRole("main")).toHaveAttribute(
      "aria-label",
      "Search results",
    );
  });
});
