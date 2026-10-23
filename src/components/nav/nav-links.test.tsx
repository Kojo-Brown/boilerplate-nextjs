// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import ar from "../../../messages/ar.json";
import en from "../../../messages/en.json";
import { NavLinks } from "./nav-links";
import { NAV_ITEMS } from "./nav-items";

const mockUsePathname = vi.fn();

/**
 * `@/i18n/navigation` and not `next/navigation`, which is the point of the
 * mock: the component reads the *locale-stripped* pathname, and mocking the
 * wrapper is what lets a test state a pathname in the form the component
 * actually receives. The previous version of this file mocked
 * `next/navigation`, which the component no longer imports — so the mock would
 * have been inert and `usePathname` would have thrown for want of a router.
 */
vi.mock("@/i18n/navigation", () => ({
  usePathname: () => mockUsePathname(),
  Link: ({
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
    renderWithProviders(<NavLinks />);
    for (const item of NAV_ITEMS) {
      expect(screen.getByText(en.nav[item.labelKey])).toBeInTheDocument();
    }
  });

  it("marks active link with aria-current", () => {
    mockUsePathname.mockReturnValue("/dashboard");
    renderWithProviders(<NavLinks />);
    const dashboardLink = screen.getByText(en.nav.dashboard).closest("a");
    expect(dashboardLink).toHaveAttribute("aria-current", "page");
  });

  it("does not mark inactive links with aria-current", () => {
    mockUsePathname.mockReturnValue("/dashboard");
    renderWithProviders(<NavLinks />);
    const adminLink = screen.getByText(en.nav.admin).closest("a");
    expect(adminLink).not.toHaveAttribute("aria-current");
  });

  it("marks nested route as active", () => {
    mockUsePathname.mockReturnValue("/admin/users");
    renderWithProviders(<NavLinks />);
    const adminLink = screen.getByText(en.nav.admin).closest("a");
    expect(adminLink).toHaveAttribute("aria-current", "page");
  });

  it("calls onNavigate when a link is clicked", async () => {
    const onNavigate = vi.fn();
    const { user } = renderWithProviders(<NavLinks onNavigate={onNavigate} />);
    await user.click(screen.getByText(en.nav.dashboard));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("renders nav element with aria-label", () => {
    renderWithProviders(<NavLinks />);
    expect(
      screen.getByRole("navigation", { name: en.nav.label }),
    ).toBeInTheDocument();
  });

  it("labels every item and the landmark from the active locale's catalogue", () => {
    renderWithProviders(<NavLinks />, { locale: "ar" });

    expect(
      screen.getByRole("navigation", { name: ar.nav.label }),
    ).toBeInTheDocument();
    for (const item of NAV_ITEMS) {
      expect(screen.getByText(ar.nav[item.labelKey])).toBeInTheDocument();
    }
  });

  it("keeps hrefs as public paths so the locale prefix is the wrapper's job", () => {
    // The hrefs are written without a prefix and `@/i18n/navigation`'s `Link`
    // adds one per locale. A component that interpolated the locale itself
    // would produce `/ar/dashboard` here and `/en/dashboard` under `en`, and
    // `en` is served unprefixed — so the second of those is a redirect on
    // every click.
    renderWithProviders(<NavLinks />, { locale: "ar" });
    expect(screen.getByText(ar.nav.dashboard).closest("a")).toHaveAttribute(
      "href",
      "/dashboard",
    );
  });

  it("marks the active link when the pathname carries a locale prefix", () => {
    // `usePathname` from `@/i18n/navigation` strips the prefix, so the
    // component compares `/dashboard` against `/dashboard` on `/ar/dashboard`.
    // With `next/navigation`'s version this value would be `/ar/dashboard`,
    // which matches no `NAV_ITEMS` href — every item would render without
    // `aria-current` in every locale but the default.
    mockUsePathname.mockReturnValue("/dashboard");
    renderWithProviders(<NavLinks />, { locale: "ar" });
    expect(screen.getByText(ar.nav.dashboard).closest("a")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
