import Link from "next/link";
import { prisma } from "@/lib/prisma";

type RecentPostsProps = {
  userId: string;
};

async function fetchRecentPosts(userId: string) {
  return prisma.post.findMany({
    where: { authorId: userId },
    select: {
      id: true,
      title: true,
      published: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
}

export async function RecentPosts({ userId }: RecentPostsProps) {
  const posts = await fetchRecentPosts(userId);

  return (
    <div
      className="rounded-xl border p-6"
      style={{ backgroundColor: "var(--background)" }}
    >
      <div className="mb-4 flex items-center justify-between">
        <h2
          className="text-sm font-medium uppercase tracking-wider"
          style={{ color: "var(--muted-foreground)" }}
        >
          Recent Posts
        </h2>
        <Link
          href="/posts"
          className="text-xs font-medium hover:underline"
          style={{ color: "var(--primary)" }}
        >
          View all
        </Link>
      </div>

      {posts.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
          No posts yet.{" "}
          <Link href="/posts" className="font-medium hover:underline" style={{ color: "var(--primary)" }}>
            Create your first post
          </Link>
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {posts.map((post) => (
            <li
              key={post.id}
              className="flex items-center justify-between rounded-lg border px-3 py-2.5"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium"
                  style={
                    post.published
                      ? {
                          backgroundColor: "var(--primary)",
                          color: "var(--primary-foreground)",
                        }
                      : {
                          backgroundColor: "var(--muted)",
                          color: "var(--muted-foreground)",
                        }
                  }
                >
                  {post.published ? "Live" : "Draft"}
                </span>
                <span className="truncate text-sm font-medium">{post.title}</span>
              </div>
              <time
                dateTime={post.createdAt.toISOString()}
                className="ml-4 shrink-0 text-xs"
                style={{ color: "var(--muted-foreground)" }}
              >
                {post.createdAt.toLocaleDateString()}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
