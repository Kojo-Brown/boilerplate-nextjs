// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, cleanup } from "@testing-library/react";
// The drawer renders `<NavLinks>`, which calls `useTranslations`, so it needs
// the catalogue in context. `renderWithProviders` is where that lives.
import { renderWithProviders as render } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { MobileDrawer } from "./mobile-drawer";

/**
 * `@/i18n/navigation`, which is what the components under test import now.
 *
 * Mocking `next/link` and a one-export `next/navigation` was enough until the
 * locale-aware wrappers arrived. It stopped being enough in two ways at once:
 * the components no longer import either module, so the mocks were inert, and
 * replacing `next/navigation` wholesale with `{usePathname}` removed the
 * `redirect` and `permanentRedirect` that `next-intl`'s own wrappers import at
 * module scope — so the file failed to import rather than failing an
 * assertion. `src/test/setup.ts` has the complete `next/navigation` stand-in;
 * this mock is only about the two things these tests steer.
 */
vi.mock("@/i18n/navigation", () => ({
  usePathname: () => "/dashboard",
  Link: ({
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
    expect(
      screen.getByRole("dialog", { name: "Navigation" }),
    ).toBeInTheDocument();
  });

  it("shows app name in drawer header", () => {
    render(<MobileDrawer open={true} onClose={onClose} appName="MyApp" />);
    expect(screen.getByText("MyApp")).toBeInTheDocument();
  });

  it("calls onClose when overlay is clicked", async () => {
    render(<MobileDrawer open={true} onClose={onClose} />);
    const overlay = document.querySelector(
      'div[aria-hidden="true"]',
    ) as HTMLElement;
    await userEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when close button is clicked", async () => {
    render(<MobileDrawer open={true} onClose={onClose} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Close navigation" }),
    );
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
    expect(
      screen.getByRole("navigation", { name: "Main navigation" }),
    ).toBeInTheDocument();
  });
});
