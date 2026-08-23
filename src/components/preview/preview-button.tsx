"use client";

import { useTransition } from "react";
import { createPreviewLinkAction } from "@/actions/preview";
import { toast, toastActionError } from "@/lib/toast";

/**
 * "Preview" on a post in the dashboard — the authoring half of the flow.
 *
 * Two steps rather than a link, because a preview URL cannot be an `href`: the
 * token has to be minted by an action that has checked the caller may preview
 * this post, and a token minted when the page rendered would be a fifteen-minute
 * capability sitting in the DOM of a tab that might stay open all day. Minting
 * on click makes the link's lifetime start when the author actually asks for
 * it.
 *
 * `window.location.assign` rather than `router.push`, and this is the load-
 * bearing detail: the minted URL points at `/api/preview`, a Route Handler.
 * A client-side navigation would ask the router for an RSC payload for a path
 * that has no page, and — more to the point — the response that matters here is
 * a `Set-Cookie`, which only a real document request will commit.
 */
export function PreviewButton({
  postId,
  className,
}: {
  postId: string;
  className?: string;
}) {
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const result = await createPreviewLinkAction(postId);

      if (!result.success) {
        toastActionError(result);
        return;
      }

      toast.success("Opening preview…");
      window.location.assign(result.data.url);
    });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      className={className}
    >
      {isPending ? "Opening…" : "Preview"}
    </button>
  );
}
