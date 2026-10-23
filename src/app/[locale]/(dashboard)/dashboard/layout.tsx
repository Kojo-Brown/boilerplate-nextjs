import type { ReactNode } from "react";

/**
 * Parallel-routes layout for the dashboard.
 *
 * Next.js renders @stats, @activity, and @notifications as independent
 * streaming slots — each slot suspends and resolves independently of the
 * others, giving true parallel loading without a shared waterfall.
 */
export default function DashboardWidgetsLayout({
  children,
  stats,
  activity,
  notifications,
}: {
  children: ReactNode;
  stats: ReactNode;
  activity: ReactNode;
  notifications: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      {/* Default slot: session header rendered by page.tsx */}
      {children}

      {/* Stats slot: spans full width */}
      {stats}

      {/* Activity + Notifications: side-by-side on large screens */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">{activity}</div>
        <div className="lg:col-span-1">{notifications}</div>
      </div>
    </div>
  );
}
