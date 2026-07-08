// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NavLinks } from "./nav-links";
import { NAV_ITEMS } from "./nav-items";

const mockUsePathname = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    onClick,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: () => void;
    [key: string]: unknown;
  }) => (
    <a href={href} onClick={onClick} {...props}>
      {children}
    </a>
  ),
}));

describe("NavLinks", () => {
  beforeEach(() => {
    mockUsePathname.mockReturnValue("/dashboard");
  });

  it("renders all nav items", () => {
    render(<NavLinks />);
    for (const item of NAV_ITEMS) {
      expect(screen.getByText(item.label)).toBeInTheDocument();
    }
  });

  it("marks active link with aria-current", () => {
    mockUsePathname.mockReturnValue("/dashboard");
    render(<NavLinks />);
    const dashboardLink = screen.getByText("Dashboard").closest("a");
    expect(dashboardLink).toHaveAttribute("aria-current", "page");
  });

  it("does not mark inactive links with aria-current", () => {
    mockUsePathname.mockReturnValue("/dashboard");
    render(<NavLinks />);
    const adminLink = screen.getByText("Admin").closest("a");
    expect(adminLink).not.toHaveAttribute("aria-current");
  });

  it("marks nested route as active", () => {
    mockUsePathname.mockReturnValue("/admin/users");
    render(<NavLinks />);
    const adminLink = screen.getByText("Admin").closest("a");
    expect(adminLink).toHaveAttribute("aria-current", "page");
  });

  it("calls onNavigate when a link is clicked", async () => {
    const onNavigate = vi.fn();
    render(<NavLinks onNavigate={onNavigate} />);
    await userEvent.click(screen.getByText("Dashboard"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("renders nav element with aria-label", () => {
    render(<NavLinks />);
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
  });
});
