"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ActionError } from "@/lib/actions/result";
import { defineAuthedAction } from "@/lib/actions/define-authed-action";
import { invalidate } from "@/lib/cache/invalidation";
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
 *
 * ## Hardening
 *
 * All three are built by `defineAuthedAction`, which is what applies the origin
 * check, the session assertion and the schema — in that order, before any of
 * these handlers runs. `scripts/assert-action-hardening.ts` fails CI on an
 * export here that is not. The session read and the `if (!session?.user?.id)`
 * that used to open each of these bodies are gone with it; `user` is a
 * guarantee by the time a handler is entered.
 *
 * The ownership check is *not* part of that, and stays in each handler on
 * purpose. Authentication is "who is calling", which every action needs and no
 * action should re-derive; authorisation is "may they touch this row", which is
 * a question about the data and can only be answered next to the query that
 * loads it.
 */

const postIdSchema = z
  .string()
  .min(1, "A post id is required")
  .max(64, "That is not a post id");

const createPostSchema = z.object({
  title: z
    .string()
    .min(1, "Title is required")
    .max(255, "Title must be under 255 characters"),
  content: z.string().max(100_000, "Content is too long").optional(),
});

/** The fields every mutation returns, so the three cannot drift apart. */
const postSummarySelect = {
  id: true,
  title: true,
  published: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, name: true, email: true } },
} as const;

export const createPostAction = defineAuthedAction({
  name: "createPost",
  input: createPostSchema,
  unauthenticatedMessage: "You must be signed in to create a post.",
  handler: async ({ input, user }): Promise<PostSummary> => {
    const post = await prisma.post.create({
      data: {
        title: input.title,
        ...(input.content !== undefined && { content: input.content }),
        authorId: user.id,
      },
      select: postSummarySelect,
    });

    invalidate({
      kind: "post.created",
      postId: post.id,
      published: post.published,
    });
    return post;
  },
});

export const deletePostAction = defineAuthedAction({
  name: "deletePost",
  input: postIdSchema,
  unauthenticatedMessage: "You must be signed in to delete a post.",
  handler: async ({ input: postId, user }): Promise<void> => {
    // `published` is selected alongside the ownership check because it is not
    // recoverable afterwards: once the row is deleted there is no way to ask
    // whether the page being dropped was ever public, and a delete that guesses
    // would either leave a 404'd post cached or purge the blog on every draft.
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { authorId: true, published: true },
    });

    if (!post) {
      throw new ActionError("Post not found.");
    }

    if (post.authorId !== user.id) {
      throw new ActionError("You can only delete your own posts.");
    }

    await prisma.post.delete({ where: { id: postId } });

    invalidate({
      kind: "post.deleted",
      postId,
      wasPublished: post.published,
    });
  },
});

export const togglePublishAction = defineAuthedAction({
  name: "togglePublish",
  input: postIdSchema,
  unauthenticatedMessage: "You must be signed in to update a post.",
  handler: async ({ input: postId, user }): Promise<PostSummary> => {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { authorId: true, published: true },
    });

    if (!post) {
      throw new ActionError("Post not found.");
    }

    if (post.authorId !== user.id) {
      throw new ActionError("You can only update your own posts.");
    }

    const updated = await prisma.post.update({
      where: { id: postId },
      data: { published: !post.published },
      select: postSummarySelect,
    });

    invalidate({
      kind: "post.updated",
      postId,
      wasPublished: post.published,
      isPublished: updated.published,
    });
    return updated;
  },
});
