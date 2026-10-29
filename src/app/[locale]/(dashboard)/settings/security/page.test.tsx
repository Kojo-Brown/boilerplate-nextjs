// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/actions/account", () => ({
  changePasswordAction: vi.fn(),
  signOutEverywhereAction: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));

import SecuritySettingsPage from "./page";

/**
 * The page must mount both forms.
 *
 * `ChangePasswordForm` has its own tests, and every one of them renders it —
 * which is exactly why they cannot notice it being absent from the application.
 * That is not a hypothetical failure in this repository: `ThemeToggle` shipped
 * with eight passing tests and no mount for weeks, leaving the dark theme
 * unreachable, and `src/app/theme-control.test.tsx` exists because of it. The
 * same assertion matters more here, because what is unreachable without the
 * mount is the only way a person can revoke their sessions.
 */
describe("SecuritySettingsPage", () => {
  it("mounts the change-password form", () => {
    render(<SecuritySettingsPage />);

    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Change password and sign out everywhere",
      }),
    ).toBeInTheDocument();
  });

  it("mounts the sign-out-everywhere form", () => {
    // The same argument as the case above, and it applies with more force: for
    // an account that signs in with Google this button is the only revocation
    // there is, and `sign-out-everywhere-form.test.tsx` renders the component
    // itself in every one of its cases.
    render(<SecuritySettingsPage />);

    expect(
      screen.getByRole("button", { name: "Sign out of every session" }),
    ).toBeInTheDocument();
  });

  it("explains that signing out everywhere needs no password", () => {
    // The card is what tells a Google-only account that the revocation it
    // cannot reach through the password form is here.
    render(<SecuritySettingsPage />);

    expect(
      screen.getByText(/without changing your password/),
    ).toBeInTheDocument();
  });

  it("says that every session ends, before anything is typed", () => {
    // The change cannot be undone and signs the reader out of the device they
    // are reading on. Saying so afterwards is not a warning.
    render(<SecuritySettingsPage />);

    expect(
      screen.getByText(/signs out every session, including this one/),
    ).toBeInTheDocument();
  });

  it("renders its own heading rather than waiting on a session", () => {
    // The page is synchronous, which is what keeps it prerenderable: the only
    // streamed hole on this route is the layout's `<UserChip>`. A session read
    // here would pull the whole body out of the static shell — see
    // `scripts/assert-streaming-boundaries.ts`.
    render(<SecuritySettingsPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Security" }),
    ).toBeInTheDocument();
  });
});
