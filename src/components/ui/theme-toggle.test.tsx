// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeToggle } from "./theme-toggle";

const mockSetTheme = vi.fn();
let mockTheme = "system";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: mockTheme, setTheme: mockSetTheme }),
}));

describe("ThemeToggle", () => {
  beforeEach(() => {
    mockTheme = "system";
    mockSetTheme.mockClear();
  });

  it("renders a button", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("has aria-label reflecting current theme (system)", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("button")).toHaveAttribute(
      "aria-label",
      "System theme",
    );
  });

  it("has aria-label reflecting current theme (light)", () => {
    mockTheme = "light";
    render(<ThemeToggle />);
    expect(screen.getByRole("button")).toHaveAttribute(
      "aria-label",
      "Light theme",
    );
  });

  it("has aria-label reflecting current theme (dark)", () => {
    mockTheme = "dark";
    render(<ThemeToggle />);
    expect(screen.getByRole("button")).toHaveAttribute(
      "aria-label",
      "Dark theme",
    );
  });

  it("cycles system → light on click", async () => {
    mockTheme = "system";
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole("button"));
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });

  it("cycles light → dark on click", async () => {
    mockTheme = "light";
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole("button"));
    expect(mockSetTheme).toHaveBeenCalledWith("dark");
  });

  it("cycles dark → system on click", async () => {
    mockTheme = "dark";
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole("button"));
    expect(mockSetTheme).toHaveBeenCalledWith("system");
  });

  it("applies custom className", () => {
    render(<ThemeToggle className="my-class" />);
    expect(screen.getByRole("button")).toHaveClass("my-class");
  });

  describe("before hydration", () => {
    // These go through a real server render rather than a mocked hook: the
    // mismatch being guarded against is specifically between what the server
    // writes and what the first client render produces, so asserting on the
    // server output is the only way to see it. `useIsHydrated` returns `true`
    // on the plain client renders above, which is why they are unaffected.

    it("renders a neutral label on the server, whatever the stored theme", () => {
      mockTheme = "dark";
      const html = renderToStaticMarkup(<ThemeToggle />);
      expect(html).toContain('aria-label="Theme"');
      expect(html).not.toContain("Dark theme");
    });

    it("still renders a button, so the header does not reflow on hydration", () => {
      const html = renderToStaticMarkup(<ThemeToggle />);
      expect(html).toContain("<button");
    });

    it("keeps the placeholder interactive rather than disabled", () => {
      // A `disabled` placeholder would flash `disabled:opacity-50` on every
      // page load; nothing else in the app is interactive pre-hydration either.
      //
      // Matched as an attribute, not a substring: `Button`'s base classes
      // include `disabled:pointer-events-none disabled:opacity-50`, so a plain
      // `not.toContain("disabled")` fails on the class list and says nothing
      // about the attribute.
      expect(renderToStaticMarkup(<ThemeToggle />)).not.toMatch(
        /<button[^>]*\sdisabled[\s=>]/,
      );
    });

    it("passes className through to the placeholder", () => {
      expect(
        renderToStaticMarkup(<ThemeToggle className="my-class" />),
      ).toContain("my-class");
    });
  });
});
