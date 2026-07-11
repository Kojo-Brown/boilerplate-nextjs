import type { Metadata } from "next";
import { getRequiredSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Your dashboard",
};

export default async function DashboardPage() {
  const session = await getRequiredSession();

  return (
    <>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted-foreground)" }}>
          Welcome back, {session.user.name ?? "there"}!
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
          Session
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs" style={{ color: "var(--muted-foreground)" }}>Name</dt>
            <dd className="mt-0.5 text-sm font-medium">{session.user.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: "var(--muted-foreground)" }}>Email</dt>
            <dd className="mt-0.5 text-sm font-medium">{session.user.email ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: "var(--muted-foreground)" }}>Role</dt>
            <dd className="mt-0.5 text-sm font-medium">{session.user.role ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: "var(--muted-foreground)" }}>User ID</dt>
            <dd className="mt-0.5 font-mono text-xs">{session.user.id ?? "—"}</dd>
          </div>
        </dl>
      </div>
    </>
  );
}
