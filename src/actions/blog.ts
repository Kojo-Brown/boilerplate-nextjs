"use server";

import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { invalidate } from "@/lib/cache/invalidation";

/**
 * On-demand invalidation for the public blog — the ISR demo's "Revalidate now"
 * button.
 *
 * The tag work itself lives in `@/lib/cache/invalidation`; this file is only
 * the endpoint. That split is deliberate, and it is what removed a hole this
 * module used to have: it previously also exported `revalidatePost(id: string)`
 * with a comment explaining that ids need no allowlist because "this is called
 * by the post mutations, not from the browser". Both halves were wrong. Every
 * export of a `"use server"` module is a network-reachable endpoint, so it *was*
 * callable from the browser with any id; and it was called by nothing at all —
 * the post mutations it was written for never imported it. Its job is now done
 * by `invalidate()` in a plain module, which the actions import and the network
 * cannot reach.
 *
 * `updateTag` rather than `revalidateTag` — and why `refresh()` is not simply
 * called alongside it — is documented on `invalidate()`.
 *
 * The allowlist that survived that episode is now the schema. `z.enum` over the
 * keys of `TARGETS` is the same guarantee the hand-written `isTarget` guard
 * gave — this action is reachable by anyone who can reach the page, so its
 * argument must not be able to name an arbitrary cache tag — expressed in the
 * one place `defineAction` enforces, and it reports the rejection as a field
 * error instead of a hand-built message.
 */

/** Targets callers may invalidate, and the mutation each maps to. */
const TARGETS = {
  "/blog": { kind: "blog.manual-refresh" },
} as const;

export type RevalidateTarget = keyof typeof TARGETS;

/**
 * `z.string().pipe(z.enum(...))` rather than the bare enum: the caller is
 * `RevalidateButton`, which takes its `path` as a `string` prop. A bare enum's
 * *input* type is the union, which would push the check up to whoever renders
 * the button — i.e. back out of the one place that enforces it. The pipe
 * accepts a string and hands the handler a `RevalidateTarget`.
 */
const targetSchema = z.string().pipe(
  z.enum(Object.keys(TARGETS) as [RevalidateTarget, ...RevalidateTarget[]], {
    message: "Not a revalidation target.",
  }),
);

export const revalidateBlogAction = defineAction({
  name: "revalidateBlog",
  input: targetSchema,
  handler: ({ input }): { path: string; tags: string[] } => {
    const tags = invalidate(TARGETS[input]);
    return { path: input, tags: [...tags] };
  },
});
