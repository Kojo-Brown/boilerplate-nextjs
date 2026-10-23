// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/actions/account", () => ({ changePasswordAction: vi.fn() }));
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

import { changePasswordAction } from "@/actions/account";
import { toast } from "@/lib/toast";
import { ChangePasswordForm } from "./change-password-form";

const mockAction = vi.mocked(changePasswordAction);

/** Fills all three boxes and submits. */
async function submit(
  values: { current?: string; next?: string; repeat?: string } = {},
): Promise<void> {
  const user = userEvent.setup();

  await user.type(
    screen.getByLabelText("Current password"),
    values.current ?? "old-password",
  );
  await user.type(
    screen.getByLabelText("New password"),
    values.next ?? "new-password",
  );
  await user.type(
    screen.getByLabelText("Repeat new password"),
    values.repeat ?? values.next ?? "new-password",
  );

  await user.click(screen.getByRole("button", { name: /Change password/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAction.mockResolvedValue({ success: true, data: undefined });
});

describe("ChangePasswordForm", () => {
  it("renders three masked inputs", () => {
    render(<ChangePasswordForm />);

    for (const label of [
      "Current password",
      "New password",
      "Repeat new password",
    ]) {
      expect(screen.getByLabelText(label)).toHaveAttribute("type", "password");
    }
  });

  it("asks the password manager for the right thing on each input", () => {
    // `new-password` on the second and third is what stops a manager filling
    // them with the credential being replaced, and what makes it offer to save
    // the new one.
    render(<ChangePasswordForm />);

    expect(screen.getByLabelText("Current password")).toHaveAttribute(
      "autoComplete",
      "current-password",
    );
    expect(screen.getByLabelText("New password")).toHaveAttribute(
      "autoComplete",
      "new-password",
    );
    expect(screen.getByLabelText("Repeat new password")).toHaveAttribute(
      "autoComplete",
      "new-password",
    );
  });

  it("says what the button is going to do", () => {
    // The destructive half of this action is the part a person cannot undo, so
    // it is on the button rather than only in the prose above it.
    render(<ChangePasswordForm />);

    expect(
      screen.getByRole("button", {
        name: "Change password and sign out everywhere",
      }),
    ).toBeInTheDocument();
  });

  it("posts all three fields to the action", async () => {
    render(<ChangePasswordForm />);

    await submit();

    await waitFor(() => expect(mockAction).toHaveBeenCalledTimes(1));
    const formData = mockAction.mock.calls[0]?.[1] as FormData;
    expect(formData.get("currentPassword")).toBe("old-password");
    expect(formData.get("newPassword")).toBe("new-password");
    expect(formData.get("confirmPassword")).toBe("new-password");
  });

  it("shows a field error under the field it names", async () => {
    mockAction.mockResolvedValue({
      success: false,
      error: "Please check your input.",
      fieldErrors: { currentPassword: ["That is not your current password"] },
    });
    render(<ChangePasswordForm />);

    await submit();

    const message = await screen.findByText(
      "That is not your current password",
    );
    const input = screen.getByLabelText("Current password");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", message.id);
  });

  it("does not toast a failure that already has a field to show it", async () => {
    mockAction.mockResolvedValue({
      success: false,
      error: "Please check your input.",
      fieldErrors: { newPassword: ["Too short"] },
    });
    render(<ChangePasswordForm />);

    await submit();

    await screen.findByText("Too short");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toasts a failure that has no field", async () => {
    mockAction.mockResolvedValue({
      success: false,
      error: "This account signs in with Google and has no password to change.",
    });
    render(<ChangePasswordForm />);

    await submit();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "This account signs in with Google and has no password to change.",
      ),
    );
  });

  it("reports the change when the action returns instead of redirecting", async () => {
    // The ordinary success path navigates, so nothing is rendered. This is the
    // degraded one: the change committed and the sign-out did not, so the
    // action answers with a result and the page has to say what happened.
    render(<ChangePasswordForm />);

    await submit();

    expect(
      await screen.findByText(/every session was signed out/),
    ).toBeInTheDocument();
  });

  it("marks no field invalid before anything has been submitted", async () => {
    render(<ChangePasswordForm />);

    for (const label of [
      "Current password",
      "New password",
      "Repeat new password",
    ]) {
      expect(screen.getByLabelText(label)).not.toHaveAttribute("aria-invalid");
    }
  });
});
