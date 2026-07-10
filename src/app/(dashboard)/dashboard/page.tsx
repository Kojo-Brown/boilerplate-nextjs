import { Suspense } from "react";
import type { Metadata } from "next";
import { getRequiredSession } from "@/lib/session";
import { DashboardStats } from "./_components/dashboard-stats";
import { DashboardStatsSkeleton } from "./_components/dashboard-stats-skeleton";
import { RecentPosts } from "./_components/recent-posts";
import { RecentPostsSkeleton } from "./_components/recent-posts-skeleton";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Your dashboard",
};

export default async function DashboardPage() {
  const session = await getRequiredSession();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted-foreground)" }}>
          Welcome back, {session.user.name ?? "there"}!
        </p>
      </div>

      {/* Session info — available immediately, no Suspense needed */}
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

      {/*
       * Streamed independently — stats resolve as soon as the DB query returns.
       * The skeleton is shown until the async DashboardStats component resolves.
       */}
      <Suspense fallback={<DashboardStatsSkeleton />}>
        <DashboardStats userId={session.user.id} />
      </Suspense>

      {/*
       * Streamed independently — recent posts can resolve at a different time
       * than stats. Both queries run in parallel with the session card above.
       */}
      <Suspense fallback={<RecentPostsSkeleton />}>
        <RecentPosts userId={session.user.id} />
      </Suspense>
    </div>
  );
}
