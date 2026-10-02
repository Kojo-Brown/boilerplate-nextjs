import { cache } from "react";
// Unscoped on purpose, and only for the two reads below. `createUserLoader`
// reads `users`, which has no tenant column and no policy — a person is not
// owned by a workspace. `createPostLoader` is the draft-mode read, which is a
// whole-site preview of one workspace and runs inside `withPreviewRead`.
import { unscopedPrisma, withPreviewRead } from "@/lib/tenancy/client";
import { createBatchLoader } from "@/lib/dal/batch";
import type { BatchLoader } from "@/lib/dal/batch";
import type { PostWithAuthor } from "@/lib/dal/posts";
import type { UserProfile } from "@/lib/dal/users";

/**
 * The request-scoped batch loaders, and the only place any of them is built.
 *
 * ## The `cache(() => …)` idiom
 *
 * Each loader is constructed inside a zero-argument `cache()` call, so React
 * hands back the same instance for the life of one request and a fresh one for
 * the next. That is the whole mechanism, and the alternative that looks
 * identical is a data leak:
 *
 * ```ts
 * // Wrong. One instance for the life of the process.
 * const userLoader = createBatchLoader({ … });
 * ```
 *
 * A loader is a cache of rows keyed by id with no expiry, because a request is
 * short enough that it does not need one. At module scope that same absence of
 * expiry means the first request's rows are served to every request after it,
 * across users, until the process restarts — a row this user may not read,
 * returned from a query that was never issued on their behalf. Nothing about
 * the read path would look wrong; `assert-no-n-plus-one.ts` R6 is what keeps
 * `createBatchLoader` from being called outside this module.
 *
 * ## Why the loaders are private
 *
 * Callers get `loadUser` / `loadPost`, not the loader. A component holding a
 * loader instance could pass it somewhere with a longer life than the request,
 * which is the same defect one indirection further away.
 */

const POST_AUTHOR_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
} as const;

const USER_PROFILE_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
  role: true,
  createdAt: true,
} as const;

/**
 * The factories are exported and the instances are not.
 *
 * Everything worth testing about a loader — the query it issues, that N keys
 * become one of them, that a missing row is `null` rather than an error — is a
 * property of the instance a factory returns. It cannot be tested through
 * `loadPost`, because outside a React render `cache` has no request to key on
 * and hands back a fresh value per call, so every `loadPost` in a Vitest
 * process is its own loader and nothing ever batches. That is not a gap in the
 * loaders; it is the same property that keeps `requestMemo` from changing how
 * scripts and tests behave. Splitting the factory out is what makes the part
 * that is ours testable, leaving only React's per-request memoisation — which
 * `docs/n-plus-one.md` records a live statement count for.
 */
export function createUserLoader(): BatchLoader<string, UserProfile> {
  return createBatchLoader<string, UserProfile>({
    name: "userById",
    keyOf: (user) => user.id,
    fetch: (ids) =>
      unscopedPrisma.user.findMany({
        where: { id: { in: [...ids] } },
        select: USER_PROFILE_SELECT,
      }),
  });
}

/**
 * The draft-mode post read, for one workspace.
 *
 * `loadPost` carries no `published` and no `authorId` filter, and under
 * row-level security that is a statement about a *capability* rather than about
 * the absence of one: a connection with no scope sees published posts and
 * nothing else, so reading a draft takes the preview transaction this batch runs
 * in — and that transaction now names the workspace it may read, so this loader
 * does too. Its only caller is `getPostForPreview`. See `withPreviewRead`.
 *
 * The tenant is a constructor argument rather than a `load` argument, which is
 * what keeps it out of the batch key: an id is unique across the installation,
 * so folding the tenant into the key would make two spellings of one row, and
 * taking it per-call would let one batch mix workspaces and send a single
 * `set_config` for whichever arrived first.
 */
export function createPostLoader(
  tenantId: string,
): BatchLoader<string, PostWithAuthor> {
  return createBatchLoader<string, PostWithAuthor>({
    name: "postById",
    keyOf: (post) => post.id,
    fetch: (ids) =>
      withPreviewRead(tenantId, (tx) =>
        tx.post.findMany({
          where: { id: { in: [...ids] } },
          include: { author: { select: POST_AUTHOR_SELECT } },
        }),
      ),
  });
}

const getUserLoader = cache(createUserLoader);

/**
 * One post loader per workspace per request.
 *
 * `cache` keys on its arguments, so a request that previews one workspace — the
 * only kind there is, since the scope comes from one cookie — gets exactly one
 * loader and exactly one batched statement. Hoisting the loader above the tenant
 * instead would have meant a loader that could not know which workspace to open,
 * which is how the parameter would have ended up back on `load` and the batch
 * back to whichever tenant arrived first.
 */
const getPostLoader = cache(createPostLoader);

/**
 * One user profile by id.
 *
 * Reads of distinct ids issued close together become one
 * `… WHERE "id" IN (…)`; a repeated id is free for the rest of the request.
 */
export function loadUser(id: string): Promise<UserProfile | null> {
  return getUserLoader().load(id);
}

/** Several user profiles, positionally, `null` where there is no such user. */
export function loadUsers(
  ids: readonly string[],
): Promise<(UserProfile | null)[]> {
  return getUserLoader().loadMany(ids);
}

/**
 * One post with its author by id, from `tenantId`, published or not.
 *
 * Callers that must not return an unpublished or someone else's post use
 * `getPublishedPostById` or `getEditablePost` instead — those carry their
 * predicate in the `where`, which is what keeps the rule off the component
 * rendering the row. See the notes on both in `./posts`.
 */
export function loadPost(
  tenantId: string,
  id: string,
): Promise<PostWithAuthor | null> {
  return getPostLoader(tenantId).load(id);
}

/** Several posts, positionally, `null` where there is no such post. */
export function loadPosts(
  tenantId: string,
  ids: readonly string[],
): Promise<(PostWithAuthor | null)[]> {
  return getPostLoader(tenantId).loadMany(ids);
}
