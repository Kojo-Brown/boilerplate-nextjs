"use client";

import { useActionState, useEffect } from "react";
import { changePasswordAction } from "@/actions/account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import type { ActionResult } from "@/lib/actions/result";

/**
 * The one caller of `changePasswordAction`, and therefore the only way a person
 * can reach "sign out everywhere".
 *
 * That is the point of the component rather than a side effect of it. This
 * repository has already shipped a fully tested `ThemeToggle` that nothing
 * rendered, leaving the dark theme unreachable for weeks, and
 * `src/lib/auth/registry.ts` declined to carry a per-user revocation method for
 * precisely the same reason. A revocation with no form in front of it is the
 * same defect in a place where its absence matters more.
 */

const FIELDS = [
  {
    name: "currentPassword",
    label: "Current password",
    autoComplete: "current-password",
  },
  {
    name: "newPassword",
    label: "New password",
    autoComplete: "new-password",
  },
  {
    name: "confirmPassword",
    label: "Repeat new password",
    autoComplete: "new-password",
  },
] as const;

function fieldError(
  state: ActionResult<void> | null,
  field: string,
): string | undefined {
  if (!state || state.success) return undefined;
  return state.fieldErrors?.[field]?.[0];
}

export function ChangePasswordForm() {
  const [state, formAction, isPending] = useActionState(
    changePasswordAction,
    null,
  );

  // Only the failures with nothing to hang them under. A wrong current password
  // renders below its own input, and repeating it in a toast would say the same
  // thing twice in two places.
  useEffect(() => {
    if (!state || state.success || state.fieldErrors) return;
    toast.error(state.error);
  }, [state]);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {FIELDS.map((field) => {
        const error = fieldError(state, field.name);
        return (
          <div key={field.name} className="flex flex-col gap-1.5">
            <label htmlFor={field.name} className="text-sm font-medium">
              {field.label}
            </label>
            <Input
              id={field.name}
              name={field.name}
              type="password"
              autoComplete={field.autoComplete}
              required
              // The browser is told which input is wrong as well as the reader:
              // a message rendered next to a field is invisible to a screen
              // reader that has no way to associate the two.
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${field.name}-error` : undefined}
            />
            {error ? (
              <p id={`${field.name}-error`} className="text-xs text-red-600">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}

      {state?.success ? (
        <p className="text-xs" style={{ color: "var(--muted-foreground)" }}>
          Your password was changed and every session was signed out. Sign in
          again to continue.
        </p>
      ) : null}

      <Button type="submit" disabled={isPending} className="mt-1 self-start">
        {isPending ? "Changing…" : "Change password and sign out everywhere"}
      </Button>
    </form>
  );
}
