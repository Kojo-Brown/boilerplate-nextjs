import { cacheLife, cacheTag } from "next/cache";
import {
  getPostById,
  getPostsForPreview,
  getPublishedPostById,
  getPublishedPosts,
} from "@/lib/dal/posts";
import { BLOG_POSTS_TAG, blogPostTag } from "@/lib/cache/tags";
import { isPreviewEnabled } from "@/lib/preview/draft";
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
 * What the blog pages call. Draft mode picks the branch.
 *
 * The public branch is the cached read; the preview branch is an uncached one
 * that also returns drafts. Two properties fall out of writing it this way
 * rather than as a flag threaded into the `"use cache"` functions below:
 *
 *  1. **A draft response can never become a cache entry.** Next already
 *     guarantees this — `workStore.isDraftMode` force-revalidates every cached
 *     read and suppresses the save — but that is a framework internal, and the
 *     consequence of it changing is one reader's unpublished draft being
 *     served to the public from a shared cache. Keeping the draft read outside
 *     `"use cache"` makes the guarantee structural instead of borrowed.
 *  2. **The cached entries stay keyed on nothing.** A `{ includeDrafts }`
 *     argument would become part of the cache key, so the public list would
 *     get a second entry the first time anyone previewed, with its own timer,
 *     for no benefit.
 *
 * `renderedAt` is `new Date()` here rather than a stamp from a cache fill,
 * which is correct and not an oversight: in preview the data really was
 * computed at request time, and the ISR badge should say so.
 */
export async function getBlogIndex(): Promise<Stamped<PostSummary[]>> {
  if (await isPreviewEnabled()) {
    return { data: await getPostsForPreview(), renderedAt: new Date() };
  }
  return getCachedPublishedPosts();
}

/**
 * One post, as the current request is entitled to see it.
 *
 * The preview branch returns unpublished posts; the caller still decides what
 * to do with one, because `/blog/[slug]` has to render a draft *and* label it,
 * and a read that silently 404'd here would leave it nothing to label.
 */
export async function getBlogPost(
  id: string,
): Promise<Stamped<PostWithAuthor | null>> {
  if (await isPreviewEnabled()) {
    return { data: await getPostById(id), renderedAt: new Date() };
  }
  return getCachedPost(id);
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

  // `getPublishedPostById`, not `getPostById`. This entry is shared by every
  // public reader, so an unpublished post must not be able to enter it — see
  // the note on that function for the leak that taught us so.
  return { data: await getPublishedPostById(id), renderedAt: new Date() };
}
