import { prisma } from "@/lib/prisma";
import type { Post, User } from "@prisma/client";

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
