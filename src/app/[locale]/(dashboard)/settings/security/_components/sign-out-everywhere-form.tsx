"use client";

import { useActionState, useEffect } from "react";
import { signOutEverywhereAction } from "@/actions/account";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

/**
 * The one caller of `signOutEverywhereAction`.
 *
 * It exists for the reason stated on `ChangePasswordForm`: a revocation with
 * no form in front of it is unreachable, and this repository has shipped a
 * fully tested component that nothing rendered before. It matters more here
 * than it did there, because this is the only revocation available to an
 * account that signs in with Google and therefore has no password to change.
 *
 * No fields. The account is the session's, and a form field naming it would
 * make this a way to end somebody else's sessions — see the action.
 */
export function SignOutEverywhereForm() {
  const [state, formAction, isPending] = useActionState(
    signOutEverywhereAction,
    null,
  );

  // Every failure this action can return is a sentence with no field to sit
  // under: it has no inputs, so there is nothing for `fieldErrors` to name.
  useEffect(() => {
    if (!state || state.success) return;
    toast.error(state.error);
  }, [state]);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {/*
        Reached only when the revocation committed and the sign-out that should
        have followed it did not — the success path redirects to /login and
        never renders. Saying so is better than a page that looks unchanged:
        the cookie this browser holds is already dead.
      */}
      {state?.success ? (
        <p className="text-xs" style={{ color: "var(--muted-foreground)" }}>
          Every session was signed out. This browser&apos;s session is already
          closed — sign in again to continue.
        </p>
      ) : null}

      <Button type="submit" disabled={isPending} className="self-start">
        {isPending ? "Signing out…" : "Sign out of every session"}
      </Button>
    </form>
  );
}
