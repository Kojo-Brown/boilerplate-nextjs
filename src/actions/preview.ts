"use server";

/**
 * The two endpoints that bracket a preview session: minting a link, and
 * leaving.
 *
 * ## Where authorisation happens
 *
 * Here, and only here. A preview token is a bearer capability — `/api/preview`
 * checks the signature and nothing about who is holding it, which is what makes
 * a link forwardable to a CMS, a staging bot or a reviewer with no account.
 * That only works if minting is guarded, so this action requires a session
 * (`defineAuthedAction` supplies that leg) and requires the caller to own the
 * post, or be an ADMIN, which is the part only this handler can decide.
 *
 * The guard is a real one rather than a gesture, because every export of a
 * `"use server"` module is a network-reachable endpoint that anyone can POST
 * to. `src/actions/blog.ts` documents what happened the last time that was
 * forgotten in this repository: an exported `revalidatePost(id)` with a comment
 * asserting it was "called by the post mutations, not from the browser", which
 * was reachable from the browser and called by nothing. An unguarded
 * `createPreviewLinkAction` would be worse — it would hand any anonymous caller
 * a signed link to any post id, which is precisely the authorisation the token
 * exists to represent.
 */

import { redirect } from "next/navigation";
import { draftMode } from "next/headers";
import { z } from "zod";
import { defineNavigationAction } from "@/lib/actions/define-action";
import { defineAuthedAction } from "@/lib/actions/define-authed-action";
import { ActionError } from "@/lib/actions/result";
import { getPostById } from "@/lib/dal/posts";
import { createPreviewLink, isSafePreviewPath } from "@/lib/preview/token";
import type { Route } from "next";

/** Where the banner's "Exit preview" lands when it is given nowhere to go. */
const EXIT_FALLBACK_PATH = "/blog";

export interface PreviewLink {
  /** Absolute URL — the CMS rendering the button has no origin of ours. */
  url: string;
  /** ISO 8601. A `Date` would not survive the action's serialisation boundary. */
  expiresAt: string;
}

/**
 * Mints a preview link for one post.
 *
 * Answers the same "not found" for a post that does not exist and one the
 * caller may not preview. The alternative distinguishes them, which turns this
 * action into an oracle for which post ids are real — cheap to avoid, and the
 * ids are guessable enough (cuid, but exposed in every public URL) that it is
 * worth avoiding.
 */
export const createPreviewLinkAction = defineAuthedAction({
  name: "createPreviewLink",
  input: z.string().min(1, "A post id is required.").max(64, "Not a post id."),
  unauthenticatedMessage: "You must be signed in to create a preview link.",
  handler: async ({ input: postId, user }): Promise<PreviewLink> => {
    const post = await getPostById(postId);
    const mayPreview =
      post !== null && (post.authorId === user.id || user.role === "ADMIN");

    if (!mayPreview) {
      throw new ActionError(
        "That post does not exist, or you cannot preview it.",
      );
    }

    // The path is built here from the id we just authorised, not accepted from
    // the caller. `signPreviewToken` would reject an unsafe one anyway; the
    // point is that no caller-supplied string reaches it in the first place.
    const link = await createPreviewLink(`/blog/${post.id}`);

    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  },
});

/**
 * Ends the draft session and returns to the page the reader was on.
 *
 * Takes `FormData` because the banner is a plain `<form action={…}>` — no
 * client component, no `useTransition`, and it works before hydration, which
 * for a control whose entire job is "get me out of this mode" is worth more
 * than the styling flexibility a button handler would buy.
 *
 * `returnTo` is attacker-controllable — it arrives in a form post like anything
 * else — so it is validated rather than trusted, even though the only thing on
 * the other side of it is a redirect to our own origin. `isSafePreviewPath`
 * rejects the protocol-relative and absolute forms that would make it someone
 * else's origin.
 *
 * The validation is now the schema, and the `.catch()` is the part worth
 * reading: a navigation action has no result channel, so a rejected input
 * would otherwise throw into the segment's `error.tsx` — which for the control
 * that exits draft mode is the worst possible answer. `.catch()` states the
 * fallback as part of the contract instead. An unusable `returnTo` still leaves
 * draft mode; it just lands on `/blog`.
 */
export const exitPreviewAction = defineNavigationAction({
  name: "exitPreview",
  input: z.object({
    returnTo: z
      .string()
      .refine(isSafePreviewPath, "Not a safe in-app path")
      .catch(EXIT_FALLBACK_PATH),
  }),
  handler: async ({ input }): Promise<void> => {
    const draft = await draftMode();
    draft.disable();

    // `redirect` throws — nothing below it runs, and the cookie cleared above
    // still rides out on the redirect response.
    //
    // The assertion is unavoidable and deliberately sits next to the schema
    // that earns it. `typedRoutes` types `redirect` against a union the
    // compiler builds from the app directory, and `returnTo` arrived in a form
    // post — a runtime string the compiler cannot place in that union no matter
    // how it is checked. What the schema buys is the property that actually
    // matters here, which is that the value cannot name another origin; a safe
    // path that happens to match no route renders the 404 page like any other.
    redirect(input.returnTo as Route);
  },
});
