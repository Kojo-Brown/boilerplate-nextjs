import { notFound } from "next/navigation";
import { getRequiredSession } from "@/lib/session";
import { getEditablePost } from "@/lib/dal/posts";
import { Skeleton } from "@/components/ui/skeleton";
import { PostEditor } from "./post-editor";

/**
 * Everything on `/posts/[id]` that depends on the request: the session, and the
 * one row it is allowed to load.
 *
 * The `params` promise is threaded down here rather than awaited in the page,
 * so the heading and breadcrumb above this boundary do not wait on a database
 * read. One boundary rather than two — the session and the post resolve in
 * sequence and produce a single component, so splitting them would buy nothing
 * but a second set of streaming markers.
 *
 * `getEditablePost` filters on `authorId` in the query, so a post belonging to
 * somebody else comes back `null` and lands on the same `notFound()` as an id
 * that never existed. That is the intended answer rather than a 403 — see the
 * note on the DAL function.
 */
export async function EditorSection({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, session] = await Promise.all([params, getRequiredSession()]);
  const post = await getEditablePost(id, session.user.id);

  if (!post) notFound();

  return <PostEditor post={post} />;
}

/** The fallback, shaped like what `PostEditor` actually renders. */
export function EditorSectionFallback() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-52" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-28 rounded-md" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-64 w-full rounded-md" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>
    </div>
  );
}
