import type { ReactNode } from "react";

/**
 * The part of `/admin` that is identical for every administrator.
 *
 * Shared by `page.tsx` and `loading.tsx` so the prerendered shell and the
 * client-navigation fallback are the same tree — see `docs/streaming.md`.
 */
export function AdminFrame({ fields }: { fields: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Admin Panel</h1>
        <p
          className="mt-1 text-sm"
          style={{ color: "var(--muted-foreground)" }}
        >
          Restricted to administrators only.
        </p>
      </div>

      <div
        className="rounded-xl border p-6"
        style={{ backgroundColor: "var(--background)" }}
      >
        <h2
          className="mb-4 text-sm font-medium uppercase tracking-wider"
          style={{ color: "var(--muted-foreground)" }}
        >
          Admin Session
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2">{fields}</dl>
      </div>
    </div>
  );
}
