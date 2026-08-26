import { refresh, revalidateTag, updateTag } from "next/cache";
import { BLOG_POSTS_TAG, blogPostTag } from "./tags";

/**
 * The one place a mutation says what it changed, and the one place that decides
 * which cache tags that drops.
 *
 * ## Why this module exists
 *
 * Before it, invalidation was spelled at each call site, and the call sites
 * disagreed. `src/actions/posts.ts` — the only code in the repository that
 * actually publishes, unpublishes and deletes posts — called
 * `revalidatePath("/posts")` and nothing else. That path names the *dashboard*,
 * which reads Prisma uncached and therefore has no cache entry to drop; the
 * public blog, which does, was never touched. So publishing a post left `/blog`
 * serving a list without it for up to 60 seconds and `/blog/[slug]` serving a
 * 5-minute-old copy, and deleting a published post left its page reachable for
 * five minutes after the row was gone.
 *
 * A helper that would have done it correctly (`revalidatePost`) existed in
 * `src/actions/blog.ts`, was unit-tested, and was called by nothing. That is
 * the failure mode this module is shaped against: invalidation is a duty the
 * mutation owes to code it never calls and cannot see, so leaving each mutation
 * to remember it produces exactly one orphaned helper and three stale pages,
 * with every test green.
 *
 * ## The shape
 *
 * Mutations declare **what happened**, not which tags to drop. `tagsFor` owns
 * the mapping, so the rule lives next to the tag definitions rather than being
 * re-derived — differently — at each call site. A new cached read that needs to
 * participate adds its tag to one switch arm; it does not go hunting through
 * `src/actions/` for every mutation that might affect it.
 *
 * It is also a plain module rather than a `"use server"` one, which is a
 * correctness point and not a stylistic one. Every export of a `"use server"`
 * module is a network-reachable endpoint, so `revalidatePost(id: string)`
 * living in `src/actions/blog.ts` meant any unauthenticated caller could purge
 * the cache entry for an arbitrary post id — despite a comment above it stating
 * it was "called by the post mutations, not from the browser". Nothing here is
 * reachable from outside; only the actions that import it are.
 */

/**
 * What a mutation reports.
 *
 * The published flags are the substance. A blog cache entry only changes when a
 * post is visible to the public before or after the write, so a draft being
 * created, edited or deleted correctly drops nothing — and an *unpublish* has
 * to drop just as much as a publish, which a naive "did this write succeed"
 * trigger would get right by accident and a "is it published now" check would
 * get wrong.
 *
 * They are passed in rather than re-read here so this stays a pure function of
 * what the caller observed. `togglePublishAction` knows both the before and
 * after state because it had to read one and write the other; asking this
 * module to look them up again would race with the write it is reacting to.
 */
export type CacheMutation =
  | { kind: "post.created"; postId: string; published: boolean }
  | {
      kind: "post.updated";
      postId: string;
      wasPublished: boolean;
      isPublished: boolean;
    }
  | { kind: "post.deleted"; postId: string; wasPublished: boolean }
  /**
   * The "Revalidate /blog now" button on the blog page. Not a data mutation —
   * it is the ISR demo's on-demand trigger — but it drops a tag, so it belongs
   * to the same map rather than reaching for `updateTag` on its own.
   */
  | { kind: "blog.manual-refresh" };

/**
 * The tags a mutation drops. Pure — no Next APIs, no I/O — so the policy can be
 * tested exhaustively without a request context.
 *
 * The switch is deliberately exhaustive rather than defaulting: the declared
 * return type makes a newly added `CacheMutation` variant a type error here,
 * which is the point at which someone has to decide what it invalidates.
 */
export function tagsFor(mutation: CacheMutation): readonly string[] {
  switch (mutation.kind) {
    case "post.created":
      // Posts default to `published: false`, so this is usually empty. It is
      // still driven by the flag rather than hardcoded to `[]`, because the day
      // a "publish immediately" option is added, the correct behaviour should
      // already be here rather than be one more thing to remember.
      return mutation.published
        ? [blogPostTag(mutation.postId), BLOG_POSTS_TAG]
        : [];

    case "post.updated":
      // `was || is`, not `is`. Unpublishing changes nothing about the post that
      // is *currently* public — there isn't one — but the cached page must
      // start returning a 404 and the cached list must stop naming it.
      return mutation.wasPublished || mutation.isPublished
        ? [blogPostTag(mutation.postId), BLOG_POSTS_TAG]
        : [];

    case "post.deleted":
      return mutation.wasPublished
        ? [blogPostTag(mutation.postId), BLOG_POSTS_TAG]
        : [];

    case "blog.manual-refresh":
      return [BLOG_POSTS_TAG];
  }
}

/**
 * Applies a mutation's invalidation. Call it from a Server Action, after the
 * write has committed.
 *
 * Returns the tags dropped, which is what makes the effect assertable: the
 * alternative is a test that mocks `next/cache` and hopes the call order in
 * this function never changes.
 *
 * ## `updateTag` rather than `revalidateTag`
 *
 * Both drop the entry. Only `updateTag` gives read-your-own-writes: in Next
 * 16.2.9 `revalidateTag(tag, profile)` marks the entry stale and lets the
 * *next* request refill it, so the person who just published could still be
 * served the copy they were trying to clear. Its one-argument form is
 * deprecated (it warns and points here), and it is also the only one of the two
 * callable from a Route Handler — `updateTag` throws there by design. Every
 * caller of this module is a Server Action, so `updateTag` is the right half of
 * that pair.
 *
 * ## Why `refresh()` is conditional
 *
 * `refresh()` re-reads the *uncached* data the client is holding — the
 * dashboard's post list and stat tiles, which query Prisma per request and so
 * have no tag to drop. Something has to signal those, and it used to be a side
 * effect of `revalidatePath("/posts")`.
 *
 * It is called only when no tag was dropped, and the reason is a sharp edge in
 * Next's implementation rather than an optimisation. Both functions write the
 * same `pathWasRevalidated` field: `updateTag` sets it to
 * `ActionDidRevalidateStaticAndDynamic`, `refresh()` assigns
 * `ActionDidRevalidateDynamicOnly` unconditionally. Calling `refresh()` after
 * `updateTag` therefore *downgrades* the signal and drops the static half of
 * the revalidation the mutation just asked for. Since the stronger value
 * already covers the client refresh, the two are mutually exclusive, in this
 * order, and never both.
 */
export function invalidate(mutation: CacheMutation): readonly string[] {
  const tags = tagsFor(mutation);

  for (const tag of tags) {
    updateTag(tag);
  }

  if (tags.length === 0) {
    refresh();
  }

  return tags;
}

/**
 * The same policy, applied from a Route Handler.
 *
 * ## Why this is a second function rather than a flag on `invalidate`
 *
 * Because neither of the two calls `invalidate` makes is legal here, and both
 * fail at *runtime* rather than at typecheck:
 *
 *   - `updateTag` throws `updateTag can only be called from within a Server
 *     Action` (E872). Next tests `workStore.page.endsWith('/route')`, so the
 *     check fires for every route handler, whatever it is doing.
 *   - `refresh()` throws the same way (E870). It signals *the client that
 *     submitted the action* to re-read its uncached data, and a webhook has no
 *     such client — the caller is a CMS worker that is not rendering anything.
 *
 * So a webhook calling `invalidate()` would answer 500 to every delivery, and
 * a unit test with `next/cache` mocked would pass, because the mock is what
 * makes the throw go away. That is a sharp enough edge to be worth a separate
 * entry point with the constraint written on it, rather than a boolean whose
 * wrong value is a production-only failure.
 *
 * ## `{ expire: 0 }`
 *
 * `revalidateTag`'s second argument is the profile the dropped entry takes on.
 * Passing `"max"` — the shape Next's deprecation notice suggests — marks the
 * entry stale but keeps it servable while it refills in the background, which
 * would give this application two different meanings for "invalidated": a
 * Server Action's `updateTag` expires immediately, a webhook's would not. A CMS
 * publishing an embargoed post and a person clicking Publish should not get
 * different answers about when readers see it, so both expire immediately.
 *
 * The argument is also mandatory in practice: the one-argument form is
 * deprecated and warns on stdout, and `pnpm run strict` (`scripts/fail-on-warnings.ts`)
 * turns a warning during the build into a failure.
 *
 * Returns the tags dropped, which is what the route puts in its response body —
 * a webhook delivery log that says which tags a call cleared is the difference
 * between "the CMS is firing" and "the CMS is firing and it is doing something".
 */
export function revalidateFromWebhook(
  mutation: CacheMutation,
): readonly string[] {
  const tags = tagsFor(mutation);

  for (const tag of tags) {
    // `{ expire: 0 }` rather than a named profile: the profile table is
    // configurable per application, and this must mean "gone now" regardless of
    // what a deployment has configured `"max"` to be.
    revalidateTag(tag, { expire: 0 });
  }

  // No `refresh()` fallback. Beyond being illegal here, there is nothing to
  // refresh: the dashboard's uncached reads belong to a browser session, and
  // this request does not have one.
  return tags;
}
