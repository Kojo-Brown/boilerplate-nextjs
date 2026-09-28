import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/auth/password-change", () => ({
  changeUserPassword: vi.fn(),
  prismaPasswordChangeStore: {},
  reportPasswordChange: vi.fn(),
}));

import type { Session } from "next-auth";
import { auth, signOut } from "@/auth";
import { changeUserPassword } from "@/lib/auth/password-change";
import type { PasswordChangeOutcome } from "@/lib/auth/password-change";
import { setRequestHeaders } from "@/test/request-headers";
import { ORIGIN_REJECTED_MESSAGE } from "@/lib/actions/origin";
import { UNAUTHENTICATED_MESSAGE } from "@/lib/actions/define-authed-action";
import { changePasswordAction } from "./account";

/**
 * The action half of "sign out everywhere".
 *
 * What is asserted here is the three things the action decides and the library
 * does not: that an anonymous caller cannot reach it at all, that each refusal
 * arrives against a field the form can show it under, and that a committed
 * change is not reported as a failure when the sign-out that follows it breaks.
 * Whether the hash and the revocation actually happen is
 * `password-change.test.ts`.
 */
// NextAuth v5's `auth` is overloaded; narrowing to the bare call is what makes
// the stub types work. The same shape `preview.test.ts` uses.
const mockAuth = vi.mocked(auth as () => Promise<Session | null>);
const mockSignOut = vi.mocked(signOut);
const mockChange = vi.mocked(changeUserPassword);

/**
 * The fixture credentials, named once rather than repeated as literals — see
 * the header of `src/lib/auth/password-change.test.ts` for why a `userId` next
 * to a password-shaped string literal is worth avoiding even when neither value
 * is a secret.
 */
const CURRENT = "fixture-current-not-a-secret";
const REPLACEMENT = "fixture-replacement-not-a-secret";

const USER = "user-1";

function signedIn(userId = USER): void {
  mockAuth.mockResolvedValue({
    user: { id: userId, role: "USER" },
    expires: "2099-01-01T00:00:00.000Z",
  } as unknown as Session);
}

function form(
  fields: Partial<{
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }> = {},
): FormData {
  const data = new FormData();
  data.set("currentPassword", fields.currentPassword ?? CURRENT);
  data.set("newPassword", fields.newPassword ?? REPLACEMENT);
  data.set(
    "confirmPassword",
    fields.confirmPassword ?? fields.newPassword ?? REPLACEMENT,
  );
  return data;
}

function outcome(value: PasswordChangeOutcome): void {
  mockChange.mockResolvedValue(value);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(null);
  outcome({ kind: "changed", sessionsRevoked: 2 });
  // `redirect()` communicates by throwing, which is what `signOut` does on
  // success. The digest is what `isFrameworkSignal` matches on.
  mockSignOut.mockImplementation(async () => {
    throw Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
  });
});

describe("changePasswordAction", () => {
  it("refuses an anonymous caller before looking at the input", async () => {
    const result = await changePasswordAction(null, form());

    expect(result).toEqual({
      success: false,
      error: "You must be signed in to change your password.",
    });
    expect(result.success === false && result.error).not.toBe(
      UNAUTHENTICATED_MESSAGE,
    );
    expect(mockChange).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin post", async () => {
    signedIn();
    setRequestHeaders({
      origin: "https://evil.example",
      host: "localhost:3000",
    });

    const result = await changePasswordAction(null, form());

    expect(result).toEqual({
      success: false,
      error: ORIGIN_REJECTED_MESSAGE,
    });
    expect(mockChange).not.toHaveBeenCalled();
  });

  it("changes the password for the session's own user", async () => {
    // The id comes from the session and from nowhere else. A form field naming
    // the account would make this action a way to change somebody else's
    // password.
    signedIn("user-42");

    // Rejects with the sign-out's redirect on the success path; what this case
    // is about is the argument, not the navigation.
    await expect(changePasswordAction(null, form())).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });

    expect(mockChange).toHaveBeenCalledWith(
      {
        userId: "user-42",
        currentPassword: CURRENT,
        newPassword: REPLACEMENT,
      },
      expect.anything(),
    );
  });

  it("signs this browser out on success", async () => {
    signedIn();

    // The redirect `signOut` throws must reach the caller rather than being
    // turned into a failed `ActionResult`: swallowing it would leave the user on
    // a page whose session is already revoked.
    await expect(changePasswordAction(null, form())).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT"),
    });
    expect(mockSignOut).toHaveBeenCalledWith({ redirectTo: "/login" });
  });

  it("reports success when the change committed but the sign-out failed", async () => {
    // The change and the revocation are committed by the time `signOut` runs.
    // Answering "Something went wrong. Please try again." would be false and
    // would invite the one action that cannot work — the current password is no
    // longer current. The cookie still names a revoked family, so the proxy
    // redirects the next request anyway.
    signedIn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSignOut.mockRejectedValue(new Error("cookie store unavailable"));

    const result = await changePasswordAction(null, form());

    expect(result).toEqual({ success: true, data: undefined });
    expect(error).toHaveBeenCalled();
  });

  it("rejects a confirmation that does not match", async () => {
    signedIn();

    const result = await changePasswordAction(
      null,
      form({ newPassword: REPLACEMENT, confirmPassword: "different" }),
    );

    expect(result).toMatchObject({
      success: false,
      fieldErrors: { confirmPassword: ["The two passwords do not match"] },
    });
    expect(mockChange).not.toHaveBeenCalled();
  });

  it("rejects a new password below the minimum length", async () => {
    signedIn();

    const result = await changePasswordAction(
      null,
      form({ newPassword: "short" }),
    );

    expect(result).toMatchObject({
      success: false,
      fieldErrors: {
        newPassword: ["New password must be at least 8 characters"],
      },
    });
    expect(mockChange).not.toHaveBeenCalled();
  });

  it("rejects an empty current password without calling the library", async () => {
    signedIn();

    const result = await changePasswordAction(
      null,
      form({ currentPassword: "" }),
    );

    expect(result).toMatchObject({
      success: false,
      fieldErrors: { currentPassword: ["Enter your current password"] },
    });
    expect(mockChange).not.toHaveBeenCalled();
  });

  it("reports a wrong current password under that field", async () => {
    signedIn();
    outcome({ kind: "incorrect" });

    const result = await changePasswordAction(null, form());

    expect(result).toMatchObject({
      success: false,
      fieldErrors: { currentPassword: ["That is not your current password"] },
    });
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("reports a reused password under the new-password field", async () => {
    signedIn();
    outcome({ kind: "reused" });

    const result = await changePasswordAction(null, form());

    expect(result).toMatchObject({
      success: false,
      fieldErrors: {
        newPassword: [
          "The new password must be different from the current one",
        ],
      },
    });
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("explains an account that has no password to change", async () => {
    signedIn();
    outcome({ kind: "no_password" });

    const result = await changePasswordAction(null, form());

    expect(result).toEqual({
      success: false,
      error: "This account signs in with Google and has no password to change.",
    });
  });

  it("tells a losing race to sign in and retry", async () => {
    signedIn();
    outcome({ kind: "superseded" });

    const result = await changePasswordAction(null, form());

    expect(result).toMatchObject({ success: false });
    expect(result.success === false && result.error).toContain(
      "Please sign in again",
    );
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("does not sign anybody out when the change was refused", async () => {
    // The revocation is the library's, inside the transaction that writes the
    // hash. A refusal here must not end the caller's session on its own, or a
    // mistyped current password would log them out.
    signedIn();
    outcome({ kind: "incorrect" });

    await changePasswordAction(null, form());

    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
