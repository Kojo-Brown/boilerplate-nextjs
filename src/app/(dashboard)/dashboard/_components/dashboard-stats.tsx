import { prisma } from "@/lib/prisma";

type DashboardStatsProps = {
  userId: string;
};

async function fetchUserStats(userId: string) {
  const [postCount, publishedCount] = await Promise.all([
    prisma.post.count({ where: { authorId: userId } }),
    prisma.post.count({ where: { authorId: userId, published: true } }),
  ]);
  return { postCount, publishedCount, draftCount: postCount - publishedCount };
}

export async function DashboardStats({ userId }: DashboardStatsProps) {
  const stats = await fetchUserStats(userId);

  const tiles: Array<{ label: string; value: number; description: string }> = [
    { label: "Total Posts", value: stats.postCount, description: "All time" },
    { label: "Published", value: stats.publishedCount, description: "Live" },
    { label: "Drafts", value: stats.draftCount, description: "In progress" },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {tiles.map(({ label, value, description }) => (
        <div
          key={label}
          className="rounded-xl border p-5"
          style={{ backgroundColor: "var(--background)" }}
        >
          <p className="text-xs font-medium" style={{ color: "var(--muted-foreground)" }}>
            {label}
          </p>
          <p className="mt-1 text-3xl font-bold tabular-nums">{value}</p>
          <p className="mt-0.5 text-xs" style={{ color: "var(--muted-foreground)" }}>
            {description}
          </p>
        </div>
      ))}
    </div>
  );
}
