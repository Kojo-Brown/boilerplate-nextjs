import type { ReactNode } from "react";

/**
 * Everything on `/dashboard` that is the same for every visitor.
 *
 * It exists as a component so `page.tsx` and `loading.tsx` render one tree
 * rather than two copies of it. `page.tsx` fills the slots with Suspense
 * boundaries; `loading.tsx` fills them with the same fallbacks those boundaries
 * use. A soft navigation therefore paints the identical frame the prerendered
 * shell contains, and the two cannot drift apart when the heading changes.
 */
export function DashboardFrame({
  greeting,
  fields,
}: {
  /** Streamed on the server render, the fallback on a client navigation. */
  greeting: ReactNode;
  /** The four `<dd>` values, or their skeletons. */
  fields: ReactNode;
}) {
  return (
    <>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        {greeting}
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
        <dl className="grid gap-3 sm:grid-cols-2">{fields}</dl>
      </div>
    </>
  );
}
