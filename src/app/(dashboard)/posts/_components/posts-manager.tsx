"use client";

import { cn } from "@/lib/cn";
import { usePostsQuery, useDeletePost, useTogglePublish } from "@/hooks/use-posts";
import { CreatePostDialog } from "./create-post-dialog";
import type { PostSummary } from "@/lib/dal/posts";
import type { SerializedPostSummary } from "@/hooks/use-posts";

type PostsManagerProps = {
  userId: string;
  initialPosts: PostSummary[];
};

function PostRowSkeleton() {
  return (
    <div
      className="h-16 animate-pulse rounded-xl border"
      style={{ backgroundColor: "var(--muted)" }}
    />
  );
}

function PostRow({
  post,
  isOwn,
}: {
  post: SerializedPostSummary;
  isOwn: boolean;
}) {
  const deletePost = useDeletePost();
  const togglePublish = useTogglePublish();
  const isOptimistic = post.id.startsWith("optimistic-");

  const formatted = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(post.createdAt));

  return (
    <article
      className={cn(
        "flex items-center justify-between gap-4 rounded-xl border p-4 transition-opacity",
        isOptimistic && "opacity-60",
      )}
      style={{ backgroundColor: "var(--background)" }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold">{post.title}</h3>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
              post.published
                ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
            )}
          >
            {post.published ? "Published" : "Draft"}
          </span>
        </div>
        <p className="mt-0.5 text-xs" style={{ color: "var(--muted-foreground)" }}>
          {post.author.name ?? post.author.email} · {formatted}
        </p>
      </div>

      {isOwn && !isOptimistic && (
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => togglePublish.mutate(post.id)}
            disabled={togglePublish.isPending && togglePublish.variables === post.id}
            className="rounded-md px-2.5 py-1 text-xs font-medium border transition-colors hover:bg-[var(--muted)] disabled:opacity-50"
          >
            {post.published ? "Unpublish" : "Publish"}
          </button>
          <button
            type="button"
            onClick={() => deletePost.mutate(post.id)}
            disabled={deletePost.isPending && deletePost.variables === post.id}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-red-600 border border-red-200 transition-colors hover:bg-red-50 dark:hover:bg-red-950/20 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      )}
    </article>
  );
}

export function PostsManager({ userId, initialPosts }: PostsManagerProps) {
  const { data: posts, isLoading, isError } = usePostsQuery(initialPosts);

  const myPosts = posts?.filter((p) => p.author.id === userId || p.id.startsWith("optimistic-")) ?? [];
  const otherPosts = posts?.filter((p) => p.author.id !== userId && !p.id.startsWith("optimistic-")) ?? [];

  if (isError) {
    return (
      <p className="text-sm text-red-600">
        Failed to load posts. Please refresh the page.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2
            className="text-sm font-semibold uppercase tracking-wider"
            style={{ color: "var(--muted-foreground)" }}
          >
            My Posts ({myPosts.length})
          </h2>
          <CreatePostDialog />
        </div>

        {isLoading ? (
          <div className="flex flex-col gap-3">
            <PostRowSkeleton />
            <PostRowSkeleton />
          </div>
        ) : myPosts.length === 0 ? (
          <p
            className="rounded-xl border border-dashed p-8 text-center text-sm"
            style={{ color: "var(--muted-foreground)" }}
          >
            You haven&apos;t created any posts yet. Click <strong>New Post</strong> to get started.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {myPosts.map((post) => (
              <li key={post.id}>
                <PostRow post={post} isOwn={true} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {otherPosts.length > 0 && (
        <section>
          <h2
            className="mb-4 text-sm font-semibold uppercase tracking-wider"
            style={{ color: "var(--muted-foreground)" }}
          >
            Published by Others ({otherPosts.length})
          </h2>
          <ul className="flex flex-col gap-3">
            {otherPosts.map((post) => (
              <li key={post.id}>
                <PostRow post={post} isOwn={false} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
