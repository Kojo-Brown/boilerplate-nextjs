# Cache invalidation

How a mutation in this application tells the cache what it changed, why the
decision lives in one module instead of at each call site, and what
`unstable_cache` turned out to be worth under Cache Components.

## The bug this replaced

Three Server Actions publish, unpublish and delete posts. Each of them ended in:

```ts
revalidatePath("/posts");
```

`/posts` is the dashboard. Its reads go straight to Prisma per request and are
not cached, so there was no entry for that call to drop. The public blog, which
_is_ cached — the published list for 60 seconds, each post page for 300 — was
never invalidated by anything.

The visible behaviour:

| Action                  | What a reader of `/blog` saw                    |
| ----------------------- | ----------------------------------------------- |
| Publish a post          | Not in the list for up to 60s                   |
| Edit a published post   | Old copy on `/blog/[slug]` for up to 300s       |
| Unpublish a post        | Page kept serving for up to 300s                |
| Delete a published post | Page kept serving a deleted post for up to 300s |

A helper that would have done this correctly existed. `revalidatePost(id)` sat
in `src/actions/blog.ts`, dropped both the right tags, had two unit tests — and
was imported by nothing. The mutations it was written for never called it.

It was also, by being an export of a `"use server"` module, a network-reachable
endpoint taking an arbitrary post id, directly under a comment asserting the
opposite:

```ts
// Separate from the action above because it takes an id rather than a fixed
// target, and ids are not an allowlist — this is called by the post mutations,
// not from the browser.
```

Every export of a `"use server"` module is an action endpoint. It was callable
from the browser, with any id, by anyone.

## The shape now

Three modules, split along the two seams that matter.

**`src/lib/cache/tags.ts`** — every tag string, defined once. A cache tag is a
contract between a cached read that declares it with `cacheTag()` and a mutation
that drops it with `updateTag()`. Nothing in the type system connects those two
sides, so the string _is_ the contract. A tag spelled inline on either side can
drift on either side, and nothing fails when it does: the read keeps caching, the
mutation keeps "invalidating", and the page serves stale content until its TTL
expires.

**`src/lib/cache/invalidation.ts`** — what happened, and what that drops.
Mutations report a `CacheMutation`; `tagsFor` owns the mapping.

```ts
invalidate({
  kind: "post.updated",
  postId,
  wasPublished: post.published,
  isPublished: updated.published,
});
```

Not a plain list of tags at the call site, because invalidation is a duty the
mutation owes to code it never calls and cannot see. Leaving each mutation to
remember it is what produced one orphaned helper and four stale pages. A new
cached read that needs to participate now adds its tag to one switch arm instead
of being hunted for across `src/actions/`.

It is a plain module, not `"use server"`. That is the fix for the endpoint hole
above: nothing here is reachable from outside, only the actions that import it.

**`src/actions/*.ts`** — the endpoints, which report and do not decide.

## The policy

| Mutation                           | Drops               |
| ---------------------------------- | ------------------- |
| `post.created`, draft              | nothing             |
| `post.created`, published          | post tag + list tag |
| `post.updated`, draft → draft      | nothing             |
| `post.updated`, any published edge | post tag + list tag |
| `post.deleted`, was a draft        | nothing             |
| `post.deleted`, was published      | post tag + list tag |
| `blog.manual-refresh`              | list tag            |

Two things in that table are easy to get wrong.

**Drafts invalidate nothing.** A blog cache entry only changes when a post is
visible to the public before or after the write. Purging on every draft edit
would throw away a warm entry to no effect.

**Unpublishing invalidates as much as publishing.** The condition is
`wasPublished || isPublished`, not `isPublished`. Nothing about an unpublished
post is public any more — which is exactly why its cached page has to go: it is
still serving one, and the list still names it. A "is it published now?" check
gets this backwards.

The whole table is asserted in `src/lib/cache/invalidation.test.ts`; `tagsFor`
is pure, so it is tested without a request context.

## `updateTag`, `revalidateTag`, and `refresh`

All three appear in `next/cache` and do different things.

`updateTag(tag)` drops the entry with read-your-own-writes: the caller who just
published sees their change. `revalidateTag(tag, profile)` marks the entry stale
and lets the _next_ request refill it, so the person who clicked "Publish" can
still be served the copy they were trying to clear. In Next 16.2.9 its
single-argument form warns that it is deprecated. It is also the only one of the
two callable from a Route Handler — `updateTag` throws there by design. Every
caller here is a Server Action, so `updateTag` is the right half of that pair.

`refresh()` is not about tags at all. It re-reads the **uncached** data the
client is holding — the dashboard's post list and stat tiles, which query Prisma
per request and have no tag to drop. Something has to signal those, and it used
to happen as a side effect of `revalidatePath("/posts")`.

`invalidate()` calls it only when no tag was dropped, and that condition is a
sharp edge in Next's implementation rather than an optimisation:

```js
// updateTag → revalidate(...)
store.pathWasRevalidated = ActionDidRevalidateStaticAndDynamic; // 1

// refresh()
workStore.pathWasRevalidated = ActionDidRevalidateDynamicOnly; // 2
```

Both write the same field, and `refresh()` assigns unconditionally. Calling it
after `updateTag` **downgrades** the signal and drops the static half of the
revalidation the mutation just asked for. Since the stronger value already covers
the client refresh, the two are mutually exclusive, in that order, and never
both. Two tests hold that line.

## Why not `unstable_cache`

The spec item names `unstable_cache`, so it was tried rather than assumed. It is
**not** forbidden under Cache Components — that was the expected answer and it
was wrong. A route added for the experiment:

```tsx
const cachedPosts = unstable_cache(
  async () => getPublishedPosts(),
  ["experiment-published-posts"],
  { tags: ["blog:posts"], revalidate: 60 },
);
```

built and prerendered cleanly, appearing in the route table as fully static with
a 1-minute window:

```
├ ○ /uc-experiment                                1m      1y
```

So the reason to prefer `"use cache"` is not that the alternative fails. It is:

- **`"use cache"` needs no manual key.** `unstable_cache`'s second argument is a
  key-parts array that has to be kept in sync with the closure by hand; getting
  it wrong produces a cache that returns another call's data. The compiler
  derives the key for `"use cache"`.
- **`cacheLife` expresses three windows** — `stale`, `revalidate`, `expire` —
  where `unstable_cache` has a single `revalidate`. `stale` is what bounds how
  long a _client_ reuses its copy, which the older API cannot say at all.
- **It is `unstable_`.** The prefix is Next's own statement about the API's
  stability, and Cache Components is the direction the framework has committed
  to.

The half of the item that matters is unaffected either way: **tags are the same
namespace for both.** `updateTag("blog:posts")` drops an `unstable_cache` entry
tagged `"blog:posts"` exactly as it drops a `cacheTag("blog:posts")` one. A
codebase mixing the two invalidates them through one policy — which is the point
of keeping that policy in one module.

## The gate

`scripts/assert-cache-invalidation.ts` runs after every CI build and enforces
two rules with the TypeScript AST:

- **R1** — an exported function in `src/actions/` that performs a Prisma write
  must call `invalidate(...)`, or appear in the script's `EXEMPT` list with a
  written reason. One entry is there today: `registerAction` creates a `User`
  row, and the only cached reads that touch users reach them through their
  posts, which a new account has none of.
- **R2** — only `src/lib/cache/invalidation.ts` may import Next's invalidation
  APIs (`updateTag`, `revalidateTag`, `revalidatePath`, `refresh`). A mutation
  reaching for `updateTag` directly has minted a tag string at a call site,
  which is how the two halves of a tag contract drift apart.

Neither rule can prove a mutation drops the _right_ tags — that is what the unit
tests are for. They prove it makes the decision at all, in the one place the
decision is reviewable.

Two details are deliberate. The gate reads `export function` declarations, and
`export const x = async () => {}` is also a valid Server Action; rather than pass
what it cannot read, it **fails** on any exported value it could not walk. And a
stale exemption fails too: an entry whose target has stopped writing reads as a
reviewed decision about code that no longer does what was reviewed.

The same test file that covers the rules also runs them over the real `src/`
tree, because a gate that passes on fixtures and fails on the repository is worse
than no gate.

## Adding a cached read

1. Define its tag in `src/lib/cache/tags.ts`.
2. Declare it on the read with `cacheTag(...)`, next to `cacheLife(...)`.
3. Add it to the `tagsFor` arms of every `CacheMutation` that can change it.
4. If the mutation that changes it does not exist yet, add the variant to
   `CacheMutation` — the switch is exhaustive, so the compiler will point at the
   decision that has to be made.
