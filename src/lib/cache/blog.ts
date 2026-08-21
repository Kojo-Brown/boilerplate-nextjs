import { cacheLife, cacheTag } from "next/cache";
import { getPostById, getPublishedPosts } from "@/lib/dal/posts";
import { BLOG_POSTS_TAG, blogPostTag } from "@/lib/cache/tags";
import type { PostSummary, PostWithAuthor } from "@/lib/dal/posts";

/**
 * The cached read layer for the public blog.
 *
 * Under Cache Components, uncached data is dynamic and a route no longer
 * declares its own TTL. `export const revalidate = 60` is a hard compile error;
 * the window moves onto the *function that fetches the data*, marked
 * `"use cache"` and given a profile by `cacheLife`. That is a better fit than
 * the old route config — two routes reading the same posts now share one cache
 * entry instead of each maintaining its own timer.
 *
 * These wrappers live here rather than on the DAL functions themselves because
 * `"use cache"` is not something to apply to `@/lib/dal/posts` wholesale: the
 * dashboard reads the same table scoped to the signed-in user, and caching a
 * per-user query behind a shared key would serve one user's posts to another.
 * Only the two genuinely public reads are cached, and only here.
 *
 * The tags these entries carry are defined in `@/lib/cache/tags` and dropped by
 * `@/lib/cache/invalidation`. This module is the read half of that contract and
 * imports the strings rather than spelling them, so a rename cannot leave the
 * two halves silently disagreeing.
 */

/**
 * Both reads carry the moment their cache entry was filled.
 *
 * The pages used to compute `new Date()` in the component body. Under Cache
 * Components that is a dynamic read — the current time is exactly the kind of
 * per-request input the prerenderer refuses to bake into a static shell — so it
 * would either push the page out of the shell or fail the build. Stamping it
 * inside the cached function is also more truthful than what it replaced: the
 * "Rendered at" badge now shows when the *data* was computed, which is what a
 * reader of an ISR demo wants to know, rather than when the request arrived.
 */
export interface Stamped<T> {
  data: T;
  renderedAt: Date;
}

/**
 * Replaces `export const revalidate = 60` on `app/blog`.
 *
 * `stale` is deliberately shorter than `revalidate`: it bounds how long a
 * *client* may reuse its copy before checking back, which the route-level
 * export had no way to express.
 */
export async function getCachedPublishedPosts(): Promise<
  Stamped<PostSummary[]>
> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 31536000 });
  cacheTag(BLOG_POSTS_TAG);

  return { data: await getPublishedPosts(), renderedAt: new Date() };
}

/**
 * Replaces `export const revalidate = 300` on `app/blog/[slug]`.
 *
 * Tagged twice on purpose. Publishing a post has to drop the list, and editing
 * one has to drop that post — with a single tag every edit would invalidate
 * every page, which is the behaviour `revalidatePath("/blog")` had.
 */
export async function getCachedPost(
  id: string,
): Promise<Stamped<PostWithAuthor | null>> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 31536000 });
  cacheTag(BLOG_POSTS_TAG, blogPostTag(id));

  return { data: await getPostById(id), renderedAt: new Date() };
}
