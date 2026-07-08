// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MobileDrawer } from "./mobile-drawer";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe("MobileDrawer", () => {
  const onClose = vi.fn();

  beforeEach(() => {
    onClose.mockClear();
  });

  afterEach(() => {
    cleanup();
    document.body.style.overflow = "";
  });

  it("renders nothing when closed", () => {
    render(<MobileDrawer open={false} onClose={onClose} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders dialog when open", () => {
    render(<MobileDrawer open={true} onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
  });

  it("shows app name in drawer header", () => {
    render(<MobileDrawer open={true} onClose={onClose} appName="MyApp" />);
    expect(screen.getByText("MyApp")).toBeInTheDocument();
  });

  it("calls onClose when overlay is clicked", async () => {
    render(<MobileDrawer open={true} onClose={onClose} />);
    const overlay = document.querySelector('div[aria-hidden="true"]') as HTMLElement;
    await userEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when close button is clicked", async () => {
    render(<MobileDrawer open={true} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", async () => {
    render(<MobileDrawer open={true} onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("locks body scroll when open", () => {
    render(<MobileDrawer open={true} onClose={onClose} />);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("renders nav links when open", () => {
    render(<MobileDrawer open={true} onClose={onClose} />);
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
  });
});
