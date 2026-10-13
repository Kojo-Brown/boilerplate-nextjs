import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MAIN_CONTENT_ID, SKIP_LINK_HREF } from "@/lib/a11y/route-focus";
import { MainContent } from "./main-content";
import { SkipLink } from "./skip-link";

describe("<SkipLink>", () => {
  it("points at the main landmark", () => {
    render(<SkipLink />);
    expect(
      screen.getByRole("link", { name: "Skip to main content" }),
    ).toHaveAttribute("href", SKIP_LINK_HREF);
  });

  it("is the first thing a keyboard reaches", async () => {
    const user = userEvent.setup();
    render(
      <>
        <SkipLink />
        <a href="/elsewhere">A link in the header</a>
      </>,
    );

    await user.tab();

    expect(
      screen.getByRole("link", { name: "Skip to main content" }),
    ).toHaveFocus();
  });

  it("is reachable by keyboard rather than hidden from it", () => {
    // `sr-only` is a clip-and-offset, not `display: none` or
    // `visibility: hidden`: both of those take the element out of the tab
    // order entirely, which is the usual way a skip link ships unreachable.
    // The class list is asserted because jsdom computes no layout and cannot
    // answer the question any other way.
    render(<SkipLink />);
    const link = screen.getByRole("link", { name: "Skip to main content" });

    expect(link).toHaveClass("sr-only");
    expect(link).toHaveClass("focus:not-sr-only");
    expect(link.className).not.toMatch(/\bhidden\b/);
  });

  it("accepts replacement wording for localisation", () => {
    render(<SkipLink>Zum Hauptinhalt springen</SkipLink>);
    expect(
      screen.getByRole("link", { name: "Zum Hauptinhalt springen" }),
    ).toBeInTheDocument();
  });

  it("names the element it expects to find, so a rename breaks visibly", () => {
    render(
      <>
        <SkipLink />
        <MainContent>content</MainContent>
      </>,
    );
    const link = screen.getByRole("link", { name: "Skip to main content" });

    expect(link.dataset.skipLinkTarget).toBe(MAIN_CONTENT_ID);
    expect(document.getElementById(MAIN_CONTENT_ID)).not.toBeNull();
  });
});
