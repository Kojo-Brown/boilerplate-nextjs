// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * Every shell in the application must mount the theme control.
 *
 * `ThemeToggle` existed, was correct, and had eight passing tests for weeks
 * while being rendered by nothing — `grep -r ThemeToggle src` returned the
 * component and its own test and nothing else. A component's unit tests cannot
 * catch that, because they render it themselves. Only an assertion made against
 * the shells can, which is what this file is.
 *
 * It is written as a table rather than four separate cases so that a new shell
 * is a one-line addition here, and so the failure message names the shell that
 * lost its toggle.
 */

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
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

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

import { AppShell } from "@/components/nav/app-shell";
import AuthLayout from "@/app/(auth)/layout";
import BlogLayout from "@/app/blog/layout";
import PhotosLayout from "@/app/photos/layout";
import HomePage from "@/app/page";

const CHILD = <p>page content</p>;

const SHELLS: ReadonlyArray<{
  /** How the failure identifies itself. */
  name: string;
  /** Why this shell has to carry the control. */
  because: string;
  render: () => React.ReactElement;
}> = [
  {
    name: "dashboard shell (AppShell)",
    because: "every signed-in route renders inside it",
    render: () => <AppShell headerSlot={null}>{CHILD}</AppShell>,
  },
  {
    name: "blog shell",
    because: "/blog and /blog/[slug] are public and have their own chrome",
    render: () => <BlogLayout>{CHILD}</BlogLayout>,
  },
  {
    name: "photos shell",
    because: "/photos and /photos/[id] are public and have their own chrome",
    render: () => <PhotosLayout>{CHILD}</PhotosLayout>,
  },
  {
    name: "auth shell",
    because: "/login and /register are where a signed-out visitor arrives",
    render: () => <AuthLayout>{CHILD}</AuthLayout>,
  },
  {
    name: "landing page",
    because: "/ renders directly under the root layout, inheriting no shell",
    render: () => <HomePage />,
  },
];

describe("theme control is reachable from every shell", () => {
  for (const shell of SHELLS) {
    it(`${shell.name} mounts ThemeToggle — ${shell.because}`, () => {
      render(shell.render());

      // Queried by accessible name rather than by test id: the point is that a
      // user can find and operate it, and the name is what a screen reader
      // announces. "System theme" is the mocked state; the label tracking the
      // real theme is `theme-toggle.test.tsx`'s job, not this file's.
      expect(
        screen.getByRole("button", { name: "System theme" }),
      ).toBeInTheDocument();
    });
  }

  it("covers every shell in the application", () => {
    // A reminder to extend the table, not a check of the table against itself.
    // `src/app` has exactly these layouts plus the root one, which renders no
    // chrome of its own, and the landing page, which has no layout between it
    // and the root.
    expect(SHELLS).toHaveLength(5);
  });
});
