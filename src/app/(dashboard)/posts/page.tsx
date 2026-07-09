import type { Metadata } from "next";
import { getRequiredSession } from "@/lib/session";
import { getPostsByUser } from "@/lib/dal/posts";
import { PostsManager } from "./_components/posts-manager";

export const metadata: Metadata = {
  title: "Posts",
  description: "Browse and manage posts",
};

export default async function PostsPage() {
  const session = await getRequiredSession();
  const initialPosts = await getPostsByUser(session.user.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Posts</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted-foreground)" }}>
          {initialPosts.length === 0
            ? "No posts yet"
            : `${initialPosts.length} post${initialPosts.length === 1 ? "" : "s"} in your account`}
        </p>
      </div>

      {/* PostsManager is a Client Component backed by TanStack Query for optimistic mutations */}
      <PostsManager userId={session.user.id} initialPosts={initialPosts} />
    </div>
  );
}
