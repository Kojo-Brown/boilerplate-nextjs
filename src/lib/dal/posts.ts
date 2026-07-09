import { prisma } from "@/lib/prisma";
import { paginateQuery } from "@/lib/pagination";
import type { Post, User } from "@prisma/client";
import type { CursorPage, CursorPageParams } from "@/lib/pagination";

export type PostWithAuthor = Post & {
  author: Pick<User, "id" | "name" | "email" | "image">;
};

export type PostSummary = Pick<Post, "id" | "title" | "published" | "createdAt" | "updatedAt"> & {
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
