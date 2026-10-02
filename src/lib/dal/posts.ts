/**
 * Reading posts, in the two access worlds this application has.
 *
 * ## Public, unscoped
 *
 * `getPublishedPosts`, `getPublishedPostById` and `getPaginatedPublishedPosts`
 * serve the blog to anonymous visitors and are prerendered at build time.
 * There is no member whose tenant could scope them, so they read through
 * `unscopedPrisma` — and the `posts_public_read` policy is what limits an
 * unscoped connection to published rows. That is worth stating plainly,
 * because it changes what the `where: { published: true }` in those queries
 * is: it used to be the only thing keeping a draft off the public blog, and it
 * is now the second. Deleting it would no longer leak anything, and it stays
 * because a query that says what it wants is a query whose plan can be read.
 *
 * ## Tenant-scoped
 *
 * Everything the dashboard reads takes a `tenantId` and runs through
 * `tenantClient`, so the connection itself cannot see another workspace's
 * rows. The `authorId` filters stay: within one tenant, "whose post is this"
 * is still a question, and the tenant scope does not answer it. The two are
 * different predicates and neither subsumes the other — a workspace has
 * several members, and a member belongs to several workspaces.
 *
 * `tenantId` is the first parameter rather than part of an options object
 * because these are all memoised, and `@/lib/request-memo` keys on argument
 * identity: an object literal misses the cache every time. See R4 in
 * `scripts/assert-no-n-plus-one.ts`.
 */
import {
  tenantClient,
  unscopedPrisma,
  withPreviewRead,
} from "@/lib/tenancy/client";
import { tenantScope } from "@/lib/tenancy/scope";
import { paginateQuery } from "@/lib/pagination";
import { requestMemo } from "@/lib/request-memo";
import { loadPost } from "@/lib/dal/loaders";
import type { Post, User } from "@prisma/client";
import type { CursorPage, CursorPageParams } from "@/lib/pagination";

export type PostWithAuthor = Post & {
  author: Pick<User, "id" | "name" | "email" | "image">;
};

export type PostSummary = Pick<
  Post,
  "id" | "title" | "published" | "createdAt" | "updatedAt"
> & {
  author: Pick<User, "id" | "name" | "email">;
};

const POST_SUMMARY_SELECT = {
  id: true,
  title: true,
  published: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, name: true, email: true } },
} as const;

export const getPublishedPosts = requestMemo(async (): Promise<PostSummary[]> =>
  // Unscoped: the public blog, limited to published rows by `posts_public_read`.
  unscopedPrisma.post.findMany({
    where: { published: true },
    select: POST_SUMMARY_SELECT,
    orderBy: { createdAt: "desc" },
  }),
);

/**
 * One workspace's posts, published or not, newest first — the blog index as an
 * author previewing that workspace should see it.
 *
 * Separate from `getPublishedPosts` rather than a `{ includeDrafts }` flag on
 * it. The flag version has one call site that must never pass `true`
 * (`getCachedPublishedPosts`, whose result is written to a shared cache entry)
 * and one that must always pass it, and nothing but attention keeps them
 * apart. Two functions make "the cached read cannot return a draft" something
 * you can see at the import.
 *
 * Deliberately not scoped to an *author*: draft mode is a whole-site preview, so
 * a reader holding a preview link sees their colleagues' drafts too. It is
 * scoped to a *tenant*, which is the half that used to be missing — and the
 * `tenantId` is not a `where` clause, it is the capability itself. See
 * `withPreviewRead` and `docs/draft-mode.md` for who can open one and what that
 * grants.
 *
 * `tenantId` first and a string, so this memoises: see the note on argument
 * identity in this module's header.
 */
export const getPostsForPreview = requestMemo(
  async (tenantId: string): Promise<PostSummary[]> =>
    // Unscoped by `tenantClient`'s reckoning, and the one read that may see a
    // draft without one. The preview transaction is what the
    // `posts_preview_read` policy requires; without it this returns nothing, and
    // with it this returns `tenantId`'s rows and no other workspace's.
    withPreviewRead(tenantId, (tx) =>
      tx.post.findMany({
        select: POST_SUMMARY_SELECT,
        orderBy: { createdAt: "desc" },
      }),
    ),
);

export const getPostsByUser = requestMemo(
  async (tenantId: string, userId: string): Promise<PostSummary[]> =>
    tenantClient(tenantScope(tenantId, userId)).post.findMany({
      where: { authorId: userId },
      select: POST_SUMMARY_SELECT,
      orderBy: { createdAt: "desc" },
    }),
);

/**
 * One post with its author, published or not, from one workspace.
 *
 * Reads through the request-scoped batch loader rather than issuing its own
 * `findUnique`, which changes nothing for a single call and means N of them —
 * one per row of a list, the shape this whole layer exists to prevent — leave
 * as one `… WHERE "id" IN (…)`. See `@/lib/dal/batch` for why Prisma's own
 * batcher does not cover that case.
 *
 * It was `getPostById(id)` and the rename is the point rather than tidying.
 * "By id, with no access filter" described a read that could return any
 * workspace's draft, and read at a call site as the ordinary way to fetch a
 * post; a name that says *preview* and a parameter that says *which workspace*
 * make both facts visible at the call. There is one caller — the preview branch
 * of `getBlogPost`. The minting path in `src/actions/preview.ts` used to be the
 * second, and now reads through `getPostOwnership` instead: it has a session and
 * therefore a workspace, so it has no business on the capability that exists for
 * readers who have neither.
 */
export function getPostForPreview(
  tenantId: string,
  id: string,
): Promise<PostWithAuthor | null> {
  return loadPost(tenantId, id);
}

/**
 * Who owns one post, inside the workspace the caller is acting in.
 *
 * The authorisation read behind `createPreviewLinkAction`, and scoped rather
 * than unfiltered on purpose. A post in another workspace is `null` here, which
 * the action answers with the same "does not exist, or you cannot preview it" it
 * gives for an id that was never real — so a link can only ever name a post in
 * the workspace whose tenant it will be signed with, and the two halves of the
 * token cannot disagree.
 *
 * Two fields, because that is what the decision needs. `authorId` is the
 * ownership question the tenant scope does not answer (a workspace has several
 * members); `id` is what the handler builds the path from, taken from the row
 * rather than from the input so that the thing authorised and the thing signed
 * are the same string.
 *
 * `findUnique` is enough here — `id` is unique, and the policy, not the `where`,
 * is what confines the row to this tenant.
 */
export type PostOwnership = Pick<Post, "id" | "authorId">;

export const getPostOwnership = requestMemo(
  async (
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<PostOwnership | null> =>
    tenantClient(tenantScope(tenantId, userId)).post.findUnique({
      where: { id },
      select: { id: true, authorId: true },
    }),
);

/**
 * One post, but only if the public may read it.
 *
 * The filter is in the `where` rather than in the caller, and that placement is
 * the whole point of the function existing. `getCachedPost` writes its result
 * into a cache entry tagged for the public blog; while the published check
 * lived in `app/blog/[slug]/page.tsx`, that entry could hold an unpublished
 * post and the only thing keeping it off the screen was one `||` in a component
 * three modules away.
 *
 * That is not hypothetical. Adding draft mode meant relaxing the page's guard
 * from `if (!post || !post.published)` to `if (!post)` — correct only if the
 * read had already applied the filter, which it had not. The result was a
 * public request to an unpublished post's URL answering 200 with its full
 * contents. Nothing in the unit suite noticed; `e2e/preview.spec.ts` did, on
 * the assertion that a second browser context with no cookies gets a 404.
 *
 * `findFirst` rather than `findUnique`: `findUnique` accepts only unique fields
 * in its `where`, and `published` is not one.
 */
export const getPublishedPostById = requestMemo(
  async (id: string): Promise<PostWithAuthor | null> =>
    // Unscoped: the public blog. See this module's header.
    unscopedPrisma.post.findFirst({
      where: { id, published: true },
      include: {
        author: {
          select: { id: true, name: true, email: true, image: true },
        },
      },
    }),
);

/**
 * The fields the editor at `/posts/[id]` reads and writes.
 *
 * Deliberately not `PostWithAuthor`: the editor renders none of the author's
 * details — it is only ever the caller's own post — and a type that carries
 * them invites a component to display data the page did not need to load.
 */
export type EditablePost = Pick<
  Post,
  "id" | "title" | "content" | "published" | "updatedAt" | "version"
>;

/**
 * One post, but only if this user owns it.
 *
 * The ownership filter is in the `where` rather than left to the caller, for
 * the reason `getPublishedPostById` gives about its `published` filter: a read
 * whose access rule lives in the component that renders it is one `||` away
 * from serving somebody else's draft, and that `||` is three modules from the
 * query. Here the query cannot return a row the caller may not see, so the page
 * has one case to handle (`null` → `notFound()`) rather than two.
 *
 * A non-owner therefore gets a 404 rather than a 403. That is the intended
 * answer: "this post exists but is not yours" tells an unauthenticated prober
 * which ids are real, and the editor is not a resource whose existence is
 * public.
 *
 * `findFirst` rather than `findUnique`: `findUnique` accepts only unique fields
 * in its `where`, and `authorId` is not one.
 */
export const getEditablePost = requestMemo(
  async (
    tenantId: string,
    id: string,
    userId: string,
  ): Promise<EditablePost | null> =>
    tenantClient(tenantScope(tenantId, userId)).post.findFirst({
      where: { id, authorId: userId },
      select: {
        id: true,
        title: true,
        content: true,
        published: true,
        updatedAt: true,
        // The version the editor's next save will claim to be based on. A read
        // that omitted it would leave the client with no token to send, and the
        // save would have to fall back to an unconditional overwrite — which is
        // the lost update this column exists to prevent.
        version: true,
      },
    }),
);

export const getPostCountByUser = requestMemo(
  async (tenantId: string, userId: string): Promise<number> =>
    tenantClient(tenantScope(tenantId, userId)).post.count({
      where: { authorId: userId },
    }),
);

/**
 * How many posts this author has, split by whether they are published.
 *
 * One `GROUP BY "published"` where `/dashboard` used to run three `COUNT(*)`s —
 * `@stats` counting all posts and published ones, `@notifications` counting
 * unpublished ones — none of which could see the others because each rendered
 * behind its own boundary. The three numbers are one question about one row
 * set, and this is that question.
 *
 * `drafts` is derived rather than counted: `total - published` is exact for a
 * boolean column that cannot be null, and a third aggregate would be a number
 * that could disagree with the other two if the rows moved between statements.
 */
export interface PostCounts {
  readonly total: number;
  readonly published: number;
  readonly drafts: number;
}

export const getPostCountsByAuthor = requestMemo(
  async (tenantId: string, userId: string): Promise<PostCounts> => {
    const groups = await tenantClient(
      tenantScope(tenantId, userId),
    ).post.groupBy({
      by: ["published"],
      where: { authorId: userId },
      _count: { _all: true },
    });

    let total = 0;
    let published = 0;
    for (const group of groups) {
      total += group._count._all;
      if (group.published) published += group._count._all;
    }

    return { total, published, drafts: total - published };
  },
);

export type RecentPost = Pick<Post, "id" | "title" | "published" | "createdAt">;

/**
 * This author's newest posts, for the dashboard's activity list.
 *
 * `limit` is an argument rather than a constant because it is part of what
 * makes two callers the same read — and it is a number, so it keys the memo.
 * See the note on argument identity in `@/lib/request-memo`.
 */
export const getRecentPostsByAuthor = requestMemo(
  async (
    tenantId: string,
    userId: string,
    limit: number,
  ): Promise<RecentPost[]> =>
    tenantClient(tenantScope(tenantId, userId)).post.findMany({
      where: { authorId: userId },
      select: { id: true, title: true, published: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
);

export type LastEditedPost = Pick<Post, "title" | "updatedAt" | "published">;

/**
 * The post this author touched most recently, or `null` if they have none.
 *
 * Ordered by `updatedAt`, deliberately not by `createdAt` like
 * `getRecentPostsByAuthor` — "what you were last working on" and "what you most
 * recently wrote" are different questions, and answering the first with the
 * second would show a stale row the moment anyone edits an old post. That is
 * why this is a second query rather than the first element of the list above.
 */
export const getLastEditedPostByAuthor = requestMemo(
  async (tenantId: string, userId: string): Promise<LastEditedPost | null> =>
    tenantClient(tenantScope(tenantId, userId)).post.findFirst({
      where: { authorId: userId },
      orderBy: { updatedAt: "desc" },
      select: { title: true, updatedAt: true, published: true },
    }),
);

export async function getPaginatedPostsByUser(
  tenantId: string,
  userId: string,
  params: CursorPageParams,
): Promise<CursorPage<PostSummary>> {
  return paginateQuery(
    (args) =>
      tenantClient(tenantScope(tenantId, userId)).post.findMany({
        where: { authorId: userId },
        select: POST_SUMMARY_SELECT,
        orderBy: { createdAt: "desc" },
        ...args,
      }),
    params,
  );
}

export async function getPaginatedPublishedPosts(
  params: CursorPageParams,
): Promise<CursorPage<PostSummary>> {
  return paginateQuery(
    (args) =>
      // Unscoped: the public blog. See this module's header.
      unscopedPrisma.post.findMany({
        where: { published: true },
        select: POST_SUMMARY_SELECT,
        orderBy: { createdAt: "desc" },
        ...args,
      }),
    params,
  );
}
