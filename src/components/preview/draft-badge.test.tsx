// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DraftBadge } from "./draft-badge";

describe("DraftBadge", () => {
  it("says Draft", () => {
    render(<DraftBadge />);
    expect(screen.getByTestId("draft-badge")).toHaveTextContent("Draft");
  });

  it("merges a caller's classes rather than replacing its own", () => {
    render(<DraftBadge className="align-middle" />);
    const badge = screen.getByTestId("draft-badge");

    expect(badge.className).toContain("align-middle");
    expect(badge.className).toContain("rounded-full");
  });

  it("renders without a className", () => {
    // `cn()` has to cope with `undefined` — the blog index renders the badge
    // with no props at all.
    expect(() => render(<DraftBadge />)).not.toThrow();
  });
});
