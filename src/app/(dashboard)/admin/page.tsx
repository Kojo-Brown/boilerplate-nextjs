import type { Metadata } from "next";
import { getRequiredAdminSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Admin",
  description: "Admin panel",
};

export default async function AdminPage() {
  const session = await getRequiredAdminSession();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Admin Panel</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted-foreground)" }}>
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
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs" style={{ color: "var(--muted-foreground)" }}>
              Name
            </dt>
            <dd className="mt-0.5 text-sm font-medium">
              {session.user.name ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: "var(--muted-foreground)" }}>
              Email
            </dt>
            <dd className="mt-0.5 text-sm font-medium">
              {session.user.email ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: "var(--muted-foreground)" }}>
              Role
            </dt>
            <dd className="mt-0.5 text-sm font-medium">
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
                style={{
                  backgroundColor: "var(--primary)",
                  color: "var(--primary-foreground)",
                }}
              >
                {session.user.role}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: "var(--muted-foreground)" }}>
              User ID
            </dt>
            <dd className="mt-0.5 font-mono text-xs">{session.user.id}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
