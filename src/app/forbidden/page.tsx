import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "403 — Forbidden",
  description: "You do not have permission to access this page.",
};

export default function ForbiddenPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <p
        className="text-7xl font-bold"
        style={{ color: "var(--primary)" }}
        aria-hidden="true"
      >
        403
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">Access Forbidden</h1>
      <p className="max-w-sm text-sm" style={{ color: "var(--muted-foreground)" }}>
        You do not have the required permissions to view this page. Contact an
        administrator if you believe this is a mistake.
      </p>
      <Link
        href="/dashboard"
        className="mt-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors"
        style={{
          backgroundColor: "var(--primary)",
          color: "var(--primary-foreground)",
        }}
      >
        Back to Dashboard
      </Link>
    </div>
  );
}
