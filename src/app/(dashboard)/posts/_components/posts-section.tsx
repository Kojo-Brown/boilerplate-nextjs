import { getRequiredSession } from "@/lib/session";
import { getPostsByUser } from "@/lib/dal/posts";
import { Skeleton } from "@/components/ui/skeleton";
import { PostsManager } from "./posts-manager";

/**
 * Everything on `/posts` that depends on who is asking: the count line and the
 * list itself.
 *
 * One boundary rather than two. The count and the list come from a single
 * `getPostsByUser` call, so separate boundaries would resolve at the same
 * instant and buy nothing but a second set of streaming markers — the rule is
 * one boundary per *read*, not one per element. The `<h1>` above it is the part
 * that never depended on the request, and it now prerenders.
 */
export async function PostsSection() {
  const session = await getRequiredSession();
  const initialPosts = await getPostsByUser(session.user.id);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
        {initialPosts.length === 0
          ? "No posts yet"
          : `${initialPosts.length} post${initialPosts.length === 1 ? "" : "s"} in your account`}
      </p>

      {/* PostsManager is a Client Component backed by TanStack Query for optimistic mutations */}
      <PostsManager userId={session.user.id} initialPosts={initialPosts} />
    </div>
  );
}

/**
 * The fallback, shaped like what `PostsManager` actually renders: a section
 * heading with the "New Post" control beside it, then a vertical list of rows.
 *
 * The skeleton it replaces drew a three-column card grid, which the page has
 * never rendered — the list has been vertical since it was written. A fallback
 * that guesses at a layout is worse than no fallback, because the correction
 * happens in front of the reader.
 */
export function PostsSectionFallback() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-5 w-44" />

      <div className="flex flex-col gap-8">
        <section>
          <div className="mb-4 flex items-center justify-between">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[74px] w-full rounded-xl" />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
