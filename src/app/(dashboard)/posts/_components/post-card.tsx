import { cn } from "@/lib/cn";
import type { PostSummary } from "@/lib/dal/posts";

type PostCardProps = {
  post: PostSummary;
  className?: string;
};

export function PostCard({ post, className }: PostCardProps) {
  const formatted = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(post.createdAt));

  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-5 transition-shadow hover:shadow-sm",
        className,
      )}
      style={{ backgroundColor: "var(--background)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug">{post.title}</h3>
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

      <div className="mt-auto flex items-center justify-between text-xs" style={{ color: "var(--muted-foreground)" }}>
        <span>{post.author.name ?? post.author.email}</span>
        <time dateTime={post.createdAt.toISOString()}>{formatted}</time>
      </div>
    </article>
  );
}
