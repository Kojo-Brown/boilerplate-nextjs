"use client";

import { useActionState, useEffect } from "react";
import Link from "next/link";
import { registerAction, signInWithGoogleAction } from "@/actions/auth";
import type { ActionResult } from "@/lib/actions";
import { toast } from "@/lib/toast";

function fieldError(
  state: ActionResult<void> | null,
  field: string,
): string | undefined {
  if (!state || state.success) return undefined;
  return state.fieldErrors?.[field]?.[0];
}

export function RegisterForm() {
  const [state, formAction, isPending] = useActionState(registerAction, null);

  useEffect(() => {
    if (!state || state.success || state.fieldErrors) return;
    toast.error(state.error);
  }, [state]);

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="name" className="text-sm font-medium">
            Name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            required
            placeholder="Jane Smith"
            className="rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-offset-1"
          />
          {fieldError(state, "name") && (
            <p className="text-xs text-red-600">{fieldError(state, "name")}</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@example.com"
            className="rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-offset-1"
          />
          {fieldError(state, "email") && (
            <p className="text-xs text-red-600">{fieldError(state, "email")}</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            placeholder="Min 8 characters"
            className="rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-offset-1"
          />
          {fieldError(state, "password") && (
            <p className="text-xs text-red-600">
              {fieldError(state, "password")}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={isPending}
          className="mt-1 rounded-lg px-4 py-2.5 text-sm font-medium transition-opacity disabled:opacity-60"
          style={{
            backgroundColor: "var(--primary)",
            color: "var(--primary-foreground)",
          }}
        >
          {isPending ? "Creating account…" : "Create account"}
        </button>
      </form>

      <div className="relative flex items-center gap-3">
        <div className="h-px flex-1" style={{ backgroundColor: "var(--border)" }} />
        <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
          or
        </span>
        <div className="h-px flex-1" style={{ backgroundColor: "var(--border)" }} />
      </div>

      <form action={signInWithGoogleAction}>
        <button
          type="submit"
          className="w-full rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-muted"
        >
          Continue with Google
        </button>
      </form>

      <p
        className="text-center text-sm"
        style={{ color: "var(--muted-foreground)" }}
      >
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-medium underline-offset-2 hover:underline"
          style={{ color: "var(--primary)" }}
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
