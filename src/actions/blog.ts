"use server";

import { ok, err } from "@/lib/actions";
import { invalidate } from "@/lib/cache/invalidation";
import type { ActionResult } from "@/lib/actions";

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
 */

/**
 * Targets callers may invalidate, and the mutation each maps to.
 *
 * Still an allowlist, for the same reason the path version was one: this action
 * is reachable by anyone who can reach the page, so the argument must not be
 * able to name an arbitrary cache tag.
 */
const TARGETS = {
  "/blog": { kind: "blog.manual-refresh" },
} as const;

export type RevalidateTarget = keyof typeof TARGETS;

export async function revalidateBlogAction(
  target: string,
): Promise<ActionResult<{ path: string; tags: string[] }>> {
  if (!isTarget(target)) {
    return err(`"${target}" is not a revalidation target.`);
  }

  const tags = invalidate(TARGETS[target]);

  return ok({ path: target, tags: [...tags] });
}

function isTarget(value: string): value is RevalidateTarget {
  return Object.hasOwn(TARGETS, value);
}
