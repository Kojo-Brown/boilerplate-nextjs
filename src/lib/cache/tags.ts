/**
 * Every cache tag this application mints, in one place.
 *
 * Tags used to live next to the cached read that carried them, in
 * `@/lib/cache/blog`. That put the write side in an awkward position: a Server
 * Action that wanted to drop a tag had to import the module holding the
 * `"use cache"` functions, pulling the whole cached read layer into the
 * mutation's module graph to get at two strings.
 *
 * Splitting them out is not only tidiness. A cache tag is a contract between
 * two sides that never call each other — the read that declares it via
 * `cacheTag()` and the mutation that drops it via `updateTag()`. Nothing in the
 * type system connects those two, so the string is the entire contract, and the
 * only way to keep it honest is for both sides to import the same one. A tag
 * spelled inline on either side is a tag that can drift on either side, and
 * nothing fails when it does: the read keeps caching, the mutation keeps
 * "invalidating", and the page just serves stale content until its TTL expires.
 *
 * `scripts/assert-cache-invalidation.ts` enforces the half of that which is
 * statically checkable — no module outside `@/lib/cache/invalidation` may call
 * Next's invalidation APIs, so a tag string cannot be minted at a call site.
 */

/**
 * Invalidates the list of published posts.
 *
 * Carried by `getCachedPublishedPosts` and also by `getCachedPost`, so dropping
 * it clears the list *and* every individual post page. That is deliberately
 * blunt — see the note on `blogPostTag`.
 */
export const BLOG_POSTS_TAG = "blog:posts";

/**
 * Invalidates one post's public page.
 *
 * Because `getCachedPost` carries `BLOG_POSTS_TAG` as well, every mutation that
 * drops this tag today drops the list tag alongside it, and the list tag alone
 * would have been enough. The finer tag is still worth minting: it is the only
 * handle on a single post's entry, and it is what an invalidation that must
 * *not* clear the whole blog — a per-post CMS webhook, say — would reach for.
 * Widening it later is a one-line change; recovering per-post granularity after
 * the tag stops existing is not.
 */
export function blogPostTag(id: string): string {
  return `blog:post:${id}`;
}
