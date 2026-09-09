import { getPostCountsByAuthor } from "@/lib/dal/posts";

type DashboardStatsProps = {
  userId: string;
};

/**
 * The three tiles used to be two `prisma.post.count()` calls issued here, and
 * `@notifications` issued a third for the same author in the same render. One
 * `GROUP BY` in the data layer answers all three, and being in the data layer
 * is what lets the other slot share it — a query in a component is a query no
 * other component can see. See `docs/n-plus-one.md`.
 */
export async function DashboardStats({ userId }: DashboardStatsProps) {
  const stats = await getPostCountsByAuthor(userId);

  const tiles: Array<{ label: string; value: number; description: string }> = [
    { label: "Total Posts", value: stats.total, description: "All time" },
    { label: "Published", value: stats.published, description: "Live" },
    { label: "Drafts", value: stats.drafts, description: "In progress" },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {tiles.map(({ label, value, description }) => (
        <div
          key={label}
          className="rounded-xl border p-5"
          style={{ backgroundColor: "var(--background)" }}
        >
          <p
            className="text-xs font-medium"
            style={{ color: "var(--muted-foreground)" }}
          >
            {label}
          </p>
          <p className="mt-1 text-3xl font-bold tabular-nums">{value}</p>
          <p
            className="mt-0.5 text-xs"
            style={{ color: "var(--muted-foreground)" }}
          >
            {description}
          </p>
        </div>
      ))}
    </div>
  );
}
