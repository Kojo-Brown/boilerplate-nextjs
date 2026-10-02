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
import { cookies, draftMode } from "next/headers";
import { z } from "zod";
import { defineNavigationAction } from "@/lib/actions/define-action";
import { defineAuthedAction } from "@/lib/actions/define-authed-action";
import { ActionError } from "@/lib/actions/result";
import { getPostOwnership } from "@/lib/dal/posts";
import { createPreviewLink } from "@/lib/preview/token";
import { getRequiredTenant } from "@/lib/tenancy/active";
import {
  PREVIEW_SCOPE_COOKIE,
  PREVIEW_SCOPE_COOKIE_ATTRIBUTES,
} from "@/lib/preview/scope";
import { isSiteRelativePath } from "@/lib/security/safe-redirect";
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
 * Mints a preview link for one post, scoped to the workspace it is in.
 *
 * Answers the same "not found" for a post that does not exist, one the caller
 * may not preview, and one in another workspace. The alternative distinguishes
 * them, which turns this action into an oracle for which post ids are real —
 * cheap to avoid, and the ids are guessable enough (cuid, but exposed in every
 * public URL) that it is worth avoiding.
 *
 * ## The workspace is read, not taken
 *
 * `getRequiredTenant()` resolves the active workspace the way every other
 * request does: out of a cookie, and then checked against `memberships`. It is
 * not an input to this action and must never become one — a caller-supplied
 * tenant would be a request to mint a capability for a workspace, answered by
 * the thing whose job is to decide whether they may have one. See
 * `@/lib/tenancy/active` on why a cookie is a request rather than evidence.
 *
 * ## Why the ownership read is scoped
 *
 * It reads `getPostOwnership(tenant, user, id)` rather than the unfiltered
 * preview read it used to. Two things follow, and the second is the one that
 * closes the gap. A post outside the active workspace is invisible, so it is
 * answered as "not found" — a member of two workspaces acting in A cannot mint a
 * link for their own post in B, which would otherwise produce a token whose
 * tenant and whose path named different workspaces and which would therefore
 * open nothing. And the authorisation and the scoping are now the *same* read:
 * there is no arrangement of this handler in which the post is checked against
 * one workspace and the token signed for another.
 *
 * The `authorId === user.id || role === "ADMIN"` check stays, because the tenant
 * scope does not answer it: a workspace has several members, and "anyone in the
 * workspace may mint a link to anyone's draft" is a different product decision
 * from the one this action already made.
 */
export const createPreviewLinkAction = defineAuthedAction({
  name: "createPreviewLink",
  input: z.string().min(1, "A post id is required.").max(64, "Not a post id."),
  unauthenticatedMessage: "You must be signed in to create a preview link.",
  handler: async ({ input: postId, user }): Promise<PreviewLink> => {
    const tenant = await getRequiredTenant();
    const post = await getPostOwnership(tenant.tenantId, user.id, postId);
    const mayPreview =
      post !== null && (post.authorId === user.id || user.role === "ADMIN");

    if (!mayPreview) {
      throw new ActionError(
        "That post does not exist, or you cannot preview it.",
      );
    }

    // Both halves come from what was just authorised, not from the caller: the
    // path from the row's own id, the tenant from the resolved membership.
    // `signPreviewToken` would reject an unsafe path and an unusable tenant
    // anyway; the point is that no caller-supplied string reaches it.
    const link = await createPreviewLink({
      path: `/blog/${post.id}`,
      tenantId: tenant.tenantId,
    });

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
 * the other side of it is a redirect to our own origin. `isSiteRelativePath`
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
      .refine(isSiteRelativePath, "Not a safe in-app path")
      .catch(EXIT_FALLBACK_PATH),
  }),
  handler: async ({ input }): Promise<void> => {
    const draft = await draftMode();
    draft.disable();

    // Both cookies, for the reason `DELETE /api/preview` clears both: a scope
    // left behind outlives the session it scopes, and the next redemption would
    // overwrite it — but only if there is a next redemption. Deleted with the
    // path it was set with, because a browser matches a deletion on name and
    // path and this one is set at `/`.
    (await cookies()).delete({
      name: PREVIEW_SCOPE_COOKIE,
      path: PREVIEW_SCOPE_COOKIE_ATTRIBUTES.path,
    });

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
