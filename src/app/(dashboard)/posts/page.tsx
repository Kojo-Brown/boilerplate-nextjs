import { Suspense } from "react";
import type { Metadata } from "next";
import { getRequiredSession } from "@/lib/session";
import { getPostCountByUser } from "@/lib/dal/posts";
import { PostList } from "./_components/post-list";

export const metadata: Metadata = {
  title: "Posts",
  description: "Browse and manage posts",
};

function PostListSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-28 animate-pulse rounded-xl border"
          style={{ backgroundColor: "var(--muted)" }}
        />
      ))}
    </div>
  );
}

export default async function PostsPage() {
  const session = await getRequiredSession();
  const postCount = await getPostCountByUser(session.user.id);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Posts</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--muted-foreground)" }}>
            {postCount === 0
              ? "No posts yet"
              : `${postCount} post${postCount === 1 ? "" : "s"} in your account`}
          </p>
        </div>
      </div>

      {/* PostList is a Server Component that queries Prisma directly — no API layer. */}
      <Suspense fallback={<PostListSkeleton />}>
        <PostList userId={session.user.id} />
      </Suspense>
    </div>
  );
}
