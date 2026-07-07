// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    expect(screen.getByRole("button")).toHaveAttribute("aria-label", "System theme");
  });

  it("has aria-label reflecting current theme (light)", () => {
    mockTheme = "light";
    render(<ThemeToggle />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Light theme");
  });

  it("has aria-label reflecting current theme (dark)", () => {
    mockTheme = "dark";
    render(<ThemeToggle />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Dark theme");
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
});
