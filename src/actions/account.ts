"use server";

import { z } from "zod";
import { signOut } from "@/auth";
import { isFrameworkSignal } from "@/lib/api/errors";
import { ActionError } from "@/lib/actions/result";
import { defineAuthedFormAction } from "@/lib/actions/define-authed-action";
import {
  changeUserPassword,
  prismaPasswordChangeStore,
  reportPasswordChange,
  type PasswordChangeOutcome,
} from "@/lib/auth/password-change";

/**
 * The account's own mutations. One so far: changing the password, which is also
 * the application's "sign out everywhere".
 *
 * ## Why signing out is part of the action and not a follow-up
 *
 * `changeUserPassword` revokes every family for the user, this request's own
 * included, so by the time it returns the cookie in the browser that asked is
 * already dead — the next request presents a token whose family reads
 * `revokedAt`, and the proxy sends it to /login. Calling `signOut` here is what
 * turns that into a deliberate navigation instead of the user's next click
 * bouncing for reasons nothing on screen explains. It also clears the cookie,
 * which the revocation cannot do: revocation is server-side state, and a
 * `Set-Cookie` needs a response.
 */

/**
 * Where a successful change lands.
 *
 * `/login` with no query string on purpose: the sign-in page is asserted static
 * by `scripts/assert-route-shape.ts`, and a page that reads `searchParams` to
 * render a notice stops being prerenderable. The redirect is the notice.
 */
const POST_PASSWORD_CHANGE_PATH = "/login";

/**
 * Eight characters, matching `registerSchema` and the credentials provider.
 *
 * Deliberately the same number in all three places rather than a stricter one
 * here: a change form that demands more than the register form accepted leaves
 * an account whose current password could not be set again, and the honest fix
 * for a policy that is too low is to raise it everywhere at once.
 */
const MIN_PASSWORD_LENGTH = 8;

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: z
      .string()
      .min(
        MIN_PASSWORD_LENGTH,
        `New password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      ),
    confirmPassword: z.string().min(1, "Repeat the new password"),
  })
  // Whether the two boxes agree is a property of the submission, so it belongs
  // in the schema; whether the new password differs from the stored one is a
  // property of the *account*, so it does not, and comes back as an outcome
  // below. Reported against `confirmPassword`, which is the field the person
  // can fix without retyping anything they already got right.
  .refine((input) => input.newPassword === input.confirmPassword, {
    message: "The two passwords do not match",
    path: ["confirmPassword"],
  });

/**
 * The dependencies `@/lib/auth/password-change` is parameterised over.
 *
 * Module-private, unlike the equivalent bindings in `src/auth.ts`: every value
 * exported from a `"use server"` module is a POST endpoint, and
 * `scripts/assert-action-hardening.ts` refuses any export here that is not one
 * of the hardening factories. The tests substitute the store by mocking the
 * module it comes from.
 */
const passwordChange = {
  store: prismaPasswordChangeStore,
  report: reportPasswordChange,
  now: () => new Date(),
};

/**
 * Turns a refusal into the failure the form shows.
 *
 * One function rather than a `switch` inside the handler so the mapping is
 * exhaustive by type: a new outcome added to the union stops this compiling
 * instead of falling through to a generic sentence.
 */
function refusal(outcome: Exclude<PasswordChangeOutcome, { kind: "changed" }>) {
  switch (outcome.kind) {
    case "no_password":
      return new ActionError(
        "This account signs in with Google and has no password to change.",
      );
    case "incorrect":
      return new ActionError("Please check your input.", {
        currentPassword: ["That is not your current password"],
      });
    case "reused":
      return new ActionError("Please check your input.", {
        newPassword: [
          "The new password must be different from the current one",
        ],
      });
    case "superseded":
      // The row stopped holding the hash this request verified against, which
      // means another change won between the two statements. Not an error on
      // anybody's part, and not something to retry automatically: a retry needs
      // the current password, and what that is now is precisely what this
      // request cannot know.
      return new ActionError(
        "Your password was changed by another request. Please sign in again " +
          "and retry.",
      );
  }
}

/**
 * Changes the password and signs every session out, this one included.
 *
 * No idempotency plan, deliberately. A double submission is already safe
 * without one — the write is conditional on the hash the first attempt
 * replaced, so the second cannot write anything — and it is answered
 * "that is not your current password", which is true. A key would buy a
 * friendlier second answer at the cost of putting a client-generated value in
 * the schema of the one action where the input is two passwords.
 */
export const changePasswordAction = defineAuthedFormAction({
  name: "changePassword",
  input: changePasswordSchema,
  unauthenticatedMessage: "You must be signed in to change your password.",
  handler: async ({ input, user }): Promise<void> => {
    const outcome = await changeUserPassword(
      {
        userId: user.id,
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
      },
      passwordChange,
    );

    if (outcome.kind !== "changed") throw refusal(outcome);

    await endThisBrowsersSession();
  },
});

/**
 * Clears this browser's cookie and navigates to the sign-in page.
 *
 * The redirect is thrown, which is how `redirect()` communicates, and
 * `runHardenedAction` rethrows framework signals for exactly this reason.
 *
 * Anything else thrown is caught and logged rather than propagated, because of
 * where this call sits: the password has already been changed and every session
 * has already been revoked, both committed. Letting a failure here escape would
 * answer a request that succeeded with "Something went wrong. Please try
 * again." — and the one thing the user must not do is try again, since the
 * password they would type is no longer theirs. Swallowing it costs the
 * navigation and nothing else: the cookie the browser still holds names a
 * revoked family, so the proxy redirects the next request to /login by itself.
 */
async function endThisBrowsersSession(): Promise<void> {
  try {
    await signOut({ redirectTo: POST_PASSWORD_CHANGE_PATH });
  } catch (thrown) {
    if (isFrameworkSignal(thrown)) throw thrown;
    console.error(
      "[action] changePassword: the change committed but signing this " +
        "browser out failed:",
      thrown,
    );
  }
}
