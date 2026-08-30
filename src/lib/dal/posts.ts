import { prisma } from "@/lib/prisma";
import { paginateQuery } from "@/lib/pagination";
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

export async function getPublishedPosts(): Promise<PostSummary[]> {
  return prisma.post.findMany({
    where: { published: true },
    select: {
      id: true,
      title: true,
      published: true,
      createdAt: true,
      updatedAt: true,
      author: {
        select: { id: true, name: true, email: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

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
export async function getPostsForPreview(): Promise<PostSummary[]> {
  return prisma.post.findMany({
    select: POST_SUMMARY_SELECT,
    orderBy: { createdAt: "desc" },
  });
}

export async function getPostsByUser(userId: string): Promise<PostSummary[]> {
  return prisma.post.findMany({
    where: { authorId: userId },
    select: {
      id: true,
      title: true,
      published: true,
      createdAt: true,
      updatedAt: true,
      author: {
        select: { id: true, name: true, email: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getPostById(id: string): Promise<PostWithAuthor | null> {
  return prisma.post.findUnique({
    where: { id },
    include: {
      author: {
        select: { id: true, name: true, email: true, image: true },
      },
    },
  });
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
export async function getPublishedPostById(
  id: string,
): Promise<PostWithAuthor | null> {
  return prisma.post.findFirst({
    where: { id, published: true },
    include: {
      author: {
        select: { id: true, name: true, email: true, image: true },
      },
    },
  });
}

/**
 * The fields the editor at `/posts/[id]` reads and writes.
 *
 * Deliberately not `PostWithAuthor`: the editor renders none of the author's
 * details — it is only ever the caller's own post — and a type that carries
 * them invites a component to display data the page did not need to load.
 */
export type EditablePost = Pick<
  Post,
  "id" | "title" | "content" | "published" | "updatedAt"
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
export async function getEditablePost(
  id: string,
  userId: string,
): Promise<EditablePost | null> {
  return prisma.post.findFirst({
    where: { id, authorId: userId },
    select: {
      id: true,
      title: true,
      content: true,
      published: true,
      updatedAt: true,
    },
  });
}

export async function getPostCountByUser(userId: string): Promise<number> {
  return prisma.post.count({ where: { authorId: userId } });
}

const POST_SUMMARY_SELECT = {
  id: true,
  title: true,
  published: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, name: true, email: true } },
} as const;

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
