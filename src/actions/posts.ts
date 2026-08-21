"use server";

import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { ok, err } from "@/lib/actions";
import { invalidate } from "@/lib/cache/invalidation";
import type { ActionResult } from "@/lib/actions";
import type { PostSummary } from "@/lib/dal/posts";

/**
 * The post mutations, and the cache entries they are responsible for.
 *
 * Each of these used to end in `revalidatePath("/posts")`, which was the wrong
 * target twice over: `/posts` is the dashboard, whose reads are uncached and
 * therefore have no entry to drop, while the public blog — which caches the
 * published list for 60s and each post page for 300s — was never invalidated at
 * all. Publishing a post did not put it on `/blog`, and deleting one did not
 * take it off.
 *
 * What each write invalidates is now decided by `@/lib/cache/invalidation` from
 * the post's published state before and after; see that module for why the
 * decision lives there and not here. `scripts/assert-cache-invalidation.ts`
 * fails CI if a Server Action in this directory writes to the database without
 * going through it.
 */

const createPostSchema = z.object({
  title: z
    .string()
    .min(1, "Title is required")
    .max(255, "Title must be under 255 characters"),
  content: z.string().optional(),
});

export async function createPostAction(input: {
  title: string;
  content?: string;
}): Promise<ActionResult<PostSummary>> {
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
    data: {
      title,
      ...(content !== undefined && { content }),
      authorId: session.user.id,
    },
    select: {
      id: true,
      title: true,
      published: true,
      createdAt: true,
      updatedAt: true,
      author: { select: { id: true, name: true, email: true } },
    },
  });

  invalidate({
    kind: "post.created",
    postId: post.id,
    published: post.published,
  });
  return ok(post);
}

export async function deletePostAction(
  postId: string,
): Promise<ActionResult<void>> {
  const session = await auth();
  if (!session?.user?.id) {
    return err("You must be signed in to delete a post.");
  }

  // `published` is selected alongside the ownership check because it is not
  // recoverable afterwards: once the row is deleted there is no way to ask
  // whether the page being dropped was ever public, and a delete that guesses
  // would either leave a 404'd post cached or purge the blog on every draft.
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { authorId: true, published: true },
  });

  if (!post) {
    return err("Post not found.");
  }

  if (post.authorId !== session.user.id) {
    return err("You can only delete your own posts.");
  }

  await prisma.post.delete({ where: { id: postId } });

  invalidate({
    kind: "post.deleted",
    postId,
    wasPublished: post.published,
  });
  return ok(undefined);
}

export async function togglePublishAction(
  postId: string,
): Promise<ActionResult<PostSummary>> {
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

  invalidate({
    kind: "post.updated",
    postId,
    wasPublished: post.published,
    isPublished: updated.published,
  });
  return ok(updated);
}
