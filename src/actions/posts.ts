"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ActionError } from "@/lib/actions/result";
import {
  defineAuthedAction,
  defineAuthedFormAction,
} from "@/lib/actions/define-authed-action";
import { invalidate } from "@/lib/cache/invalidation";
import { idempotencyKeySchema } from "@/lib/actions/idempotency-key";
import type { EditablePost, PostSummary } from "@/lib/dal/posts";

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
 *
 * ## Idempotency
 *
 * `createPostAction` declares an `idempotency` plan, so a repeated submission
 * of the same client-generated key replays the first result instead of writing
 * a second post. The other three do not, and that is a decision rather than an
 * omission: each of them names the row it acts on, so repeating one is either a
 * no-op or an answer the UI already handles. See `docs/idempotency.md` for the
 * full argument and for what a caller has to do to hold up its end.
 */

const postIdSchema = z
  .string()
  .min(1, "A post id is required")
  .max(64, "That is not a post id");

/**
 * The editor's payload, parsed out of a `FormData`.
 *
 * `content` arrives as `""` from an emptied textarea, never as `undefined` —
 * a textarea always submits — so the empty case is normalised here rather than
 * being left for the handler to remember. `null` and not `""`: the column is
 * nullable, `getPublishedPostById` feeds `post.content?.slice(0, 155)` into the
 * blog's meta description, and an empty string is a value that passes `?.` and
 * produces an empty description where `null` correctly falls through to the
 * author line.
 *
 * `.optional()` before the transform anyway, so a caller posting no `content`
 * field at all — which a hand-rolled request may — lands on the same `null`
 * instead of failing a required-field check that says nothing useful.
 */
const updatePostSchema = z.object({
  postId: postIdSchema,
  title: z
    .string()
    .trim()
    .min(1, "Title is required")
    .max(255, "Title must be under 255 characters"),
  content: z
    .string()
    .max(100_000, "Content is too long")
    .optional()
    .transform((value) => (value === undefined || value === "" ? null : value)),
});

/**
 * Creating a post is the mutation with no natural key, which is what makes it
 * the one that needs a supplied one.
 *
 * Every other action here names the row it acts on: a second `deletePostAction`
 * for the same id finds the post already gone and answers "Post not found", and
 * a second `updatePostAction` writes the same values a second time. Neither
 * leaves a mess. A second `createPostAction` writes a second post — and the two
 * clicks that produce it are ordinary, not adversarial. See
 * `docs/idempotency.md`.
 *
 * The key is a required field rather than an optional one. Optional would mean
 * every call site decides for itself whether this mutation is deduplicated,
 * which is the same "convention rather than structure" that
 * `assert-action-hardening.ts` exists to rule out one level up.
 */
const createPostSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  title: z
    .string()
    .min(1, "Title is required")
    .max(255, "Title must be under 255 characters"),
  content: z.string().max(100_000, "Content is too long").optional(),
});

/**
 * The shape a replayed `createPostAction` result is revived into.
 *
 * It has to exist because a stored result is JSON: `createdAt` goes into the
 * `Json` column as a `Date` and comes back as a string, and `PostCard` calls
 * `new Date(post.createdAt)` — which happens to survive a string, while
 * anything reaching for a `Date` method would not. Coercing here means the
 * replay path and the fresh path hand back the same thing, which
 * `posts.test.ts` asserts by comparing them rather than by describing them.
 */
const postSummaryOutput = z.object({
  id: z.string(),
  title: z.string(),
  published: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  author: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string(),
  }),
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
  idempotency: {
    key: (input) => input.idempotencyKey,
    output: postSummaryOutput,
  },
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

/** The fields `/posts/[id]` reads, so the editor's read and write agree. */
const editablePostSelect = {
  id: true,
  title: true,
  content: true,
  published: true,
  updatedAt: true,
} as const;

/**
 * The editor's save, bound to its form through `useActionState`.
 *
 * A form action rather than a value action, and that is the whole reason this
 * one is built by `defineAuthedFormAction`: `useActionState` calls its action
 * as `(previous, formData)`, so an action shaped like `createPostAction` cannot
 * be passed to it at all. See `docs/optimistic-ui.md` for what the client does
 * with the result.
 *
 * It deliberately does **not** touch `published`. Saving a draft must not
 * publish it, and `togglePublishAction` already owns that transition together
 * with the before/after pair the cache policy needs; a save that also flipped
 * the flag would be two mutations reporting as one, and `wasPublished` below
 * would be a guess. So the flags handed to `invalidate` are equal here on
 * purpose — an edit to a published post drops its blog entries because the
 * *content* changed, and an edit to a draft drops nothing.
 */
export const updatePostAction = defineAuthedFormAction({
  name: "updatePost",
  input: updatePostSchema,
  unauthenticatedMessage: "You must be signed in to edit a post.",
  handler: async ({ input, user }): Promise<EditablePost> => {
    const existing = await prisma.post.findUnique({
      where: { id: input.postId },
      select: { authorId: true, published: true },
    });

    if (!existing) {
      throw new ActionError("Post not found.");
    }

    if (existing.authorId !== user.id) {
      throw new ActionError("You can only edit your own posts.");
    }

    const updated = await prisma.post.update({
      where: { id: input.postId },
      data: { title: input.title, content: input.content },
      select: editablePostSelect,
    });

    invalidate({
      kind: "post.updated",
      postId: updated.id,
      wasPublished: existing.published,
      isPublished: updated.published,
    });
    return updated;
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
