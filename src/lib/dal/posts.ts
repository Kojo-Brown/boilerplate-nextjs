import { prisma } from "@/lib/prisma";
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
  prisma.post.findMany({
    where: { published: true },
    select: POST_SUMMARY_SELECT,
    orderBy: { createdAt: "desc" },
  }),
);

/**
 * Every post, published or not, newest first — the blog index as an author
 * previewing the site should see it.
 *
 * Separate from `getPublishedPosts` rather than a `{ includeDrafts }` flag on
 * it. The flag version has one call site that must never pass `true`
 * (`getCachedPublishedPosts`, whose result is written to a shared cache entry)
 * and one that must always pass it, and nothing but attention keeps them
 * apart. Two functions make "the cached read cannot return a draft" something
 * you can see at the import.
 *
 * Deliberately not scoped to an author. Draft mode is a whole-site preview —
 * see `docs/draft-mode.md` for who can open one and what that grants.
 */
export const getPostsForPreview = requestMemo(
  async (): Promise<PostSummary[]> =>
    prisma.post.findMany({
      select: POST_SUMMARY_SELECT,
      orderBy: { createdAt: "desc" },
    }),
);

export const getPostsByUser = requestMemo(
  async (userId: string): Promise<PostSummary[]> =>
    prisma.post.findMany({
      where: { authorId: userId },
      select: POST_SUMMARY_SELECT,
      orderBy: { createdAt: "desc" },
    }),
);

/**
 * One post with its author, with no access filter.
 *
 * Reads through the request-scoped batch loader rather than issuing its own
 * `findUnique`, which changes nothing for a single call and means N of them —
 * one per row of a list, the shape this whole layer exists to prevent — leave
 * as one `… WHERE "id" IN (…)`. See `@/lib/dal/batch` for why Prisma's own
 * batcher does not cover that case.
 */
export function getPostById(id: string): Promise<PostWithAuthor | null> {
  return loadPost(id);
}

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
    prisma.post.findFirst({
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
  async (id: string, userId: string): Promise<EditablePost | null> =>
    prisma.post.findFirst({
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
  async (userId: string): Promise<number> =>
    prisma.post.count({ where: { authorId: userId } }),
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
  async (userId: string): Promise<PostCounts> => {
    const groups = await prisma.post.groupBy({
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
  async (userId: string, limit: number): Promise<RecentPost[]> =>
    prisma.post.findMany({
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
  async (userId: string): Promise<LastEditedPost | null> =>
    prisma.post.findFirst({
      where: { authorId: userId },
      orderBy: { updatedAt: "desc" },
      select: { title: true, updatedAt: true, published: true },
    }),
);

export async function getPaginatedPostsByUser(
  userId: string,
  params: CursorPageParams,
): Promise<CursorPage<PostSummary>> {
  return paginateQuery(
    (args) =>
      prisma.post.findMany({
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
      prisma.post.findMany({
        where: { published: true },
        select: POST_SUMMARY_SELECT,
        orderBy: { createdAt: "desc" },
        ...args,
      }),
    params,
  );
}
