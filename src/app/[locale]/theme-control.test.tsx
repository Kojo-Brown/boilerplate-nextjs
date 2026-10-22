// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
// Every shell here renders the navigation, which reads the catalogue.
import { renderWithProviders as render } from "@/test/render";

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

import { AppShell } from "@/components/nav/app-shell";
import AuthLayout from "@/app/[locale]/(auth)/layout";
import BlogLayout from "@/app/[locale]/blog/layout";
import PhotosLayout from "@/app/[locale]/photos/layout";
import HomePage from "@/app/[locale]/page";

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
  usePathname: () => "/",
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
