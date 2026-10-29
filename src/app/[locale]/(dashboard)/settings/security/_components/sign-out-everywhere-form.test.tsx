// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/actions/account", () => ({ signOutEverywhereAction: vi.fn() }));
vi.mock("@/lib/toast", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    promise: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

import { signOutEverywhereAction } from "@/actions/account";
import { toast } from "@/lib/toast";
import { SignOutEverywhereForm } from "./sign-out-everywhere-form";

const mockAction = vi.mocked(signOutEverywhereAction);

async function submit(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Sign out of every/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAction.mockResolvedValue({ success: true, data: undefined });
});

describe("SignOutEverywhereForm", () => {
  it("renders one submit button and no inputs", () => {
    // No fields is the point rather than an omission: the account comes from
    // the session, so there is nothing for this form to collect.
    render(<SignOutEverywhereForm />);

    expect(
      screen.getByRole("button", { name: "Sign out of every session" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("posts to the action", async () => {
    render(<SignOutEverywhereForm />);

    await submit();

    await waitFor(() => expect(mockAction).toHaveBeenCalledTimes(1));
  });

  it("toasts a failure, which is the only channel it has", async () => {
    mockAction.mockResolvedValue({
      success: false,
      error: "You must be signed in to sign out of your sessions.",
    });
    render(<SignOutEverywhereForm />);

    await submit();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "You must be signed in to sign out of your sessions.",
      ),
    );
  });

  it("says the sessions ended when the action returns instead of redirecting", async () => {
    // The success path redirects and never renders, so this branch means the
    // revocation committed and the sign-out after it failed. The browser's
    // cookie is already dead; a page that looked unchanged would be a lie.
    render(<SignOutEverywhereForm />);

    await submit();

    await waitFor(() =>
      expect(screen.getByText(/Every session was signed out/)).toBeVisible(),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("disables the button while the revocation is in flight", async () => {
    let settle: (value: { success: true; data: undefined }) => void = () => {};
    mockAction.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    render(<SignOutEverywhereForm />);

    await submit();

    const button = screen.getByRole("button");
    await waitFor(() => expect(button).toBeDisabled());

    settle({ success: true, data: undefined });
    await waitFor(() => expect(button).toBeEnabled());
  });
});
