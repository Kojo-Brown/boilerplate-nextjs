"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { ok, err } from "@/lib/actions";
import type { ActionResult } from "@/lib/actions";
import type { PostSummary } from "@/lib/dal/posts";

const createPostSchema = z.object({
  title: z.string().min(1, "Title is required").max(255, "Title must be under 255 characters"),
  content: z.string().optional(),
});

export async function createPostAction(
  input: { title: string; content?: string },
): Promise<ActionResult<PostSummary>> {
  const session = await auth();
  if (!session?.user?.id) {
    return err("You must be signed in to create a post.");
  }

  const parsed = createPostSchema.safeParse(input);
  if (!parsed.success) {
    return err("Invalid input.", parsed.error.flatten().fieldErrors);
  }

  const { title, content } = parsed.data;

  const post = await prisma.post.create({
    data: { title, content, authorId: session.user.id },
    select: {
      id: true,
      title: true,
      published: true,
      createdAt: true,
      updatedAt: true,
      author: { select: { id: true, name: true, email: true } },
    },
  });

  revalidatePath("/posts");
  return ok(post);
}

export async function deletePostAction(postId: string): Promise<ActionResult<void>> {
  const session = await auth();
  if (!session?.user?.id) {
    return err("You must be signed in to delete a post.");
  }

  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { authorId: true },
  });

  if (!post) {
    return err("Post not found.");
  }

  if (post.authorId !== session.user.id) {
    return err("You can only delete your own posts.");
  }

  await prisma.post.delete({ where: { id: postId } });

  revalidatePath("/posts");
  return ok(undefined);
}

export async function togglePublishAction(postId: string): Promise<ActionResult<PostSummary>> {
  const session = await auth();
  if (!session?.user?.id) {
    return err("You must be signed in to update a post.");
  }

  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { authorId: true, published: true },
  });

  if (!post) {
    return err("Post not found.");
  }

  if (post.authorId !== session.user.id) {
    return err("You can only update your own posts.");
  }

  const updated = await prisma.post.update({
    where: { id: postId },
    data: { published: !post.published },
    select: {
      id: true,
      title: true,
      published: true,
      createdAt: true,
      updatedAt: true,
      author: { select: { id: true, name: true, email: true } },
    },
  });

  revalidatePath("/posts");
  return ok(updated);
}
