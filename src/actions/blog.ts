"use server";

import { updateTag } from "next/cache";
import { ok, err } from "@/lib/actions";
import { BLOG_POSTS_TAG, blogPostTag } from "@/lib/cache/blog";
import type { ActionResult } from "@/lib/actions";

/**
 * On-demand invalidation for the public blog.
 *
 * This used to call `revalidatePath("/blog")`. Under Cache Components the unit
 * of invalidation is the cache entry, not the URL — a tag drops the entry
 * wherever it is read from, so the list page and every post page that shares it
 * stay consistent without this action having to know which routes happen to
 * render it.
 *
 * That also fixes a real staleness bug in the old version: `/blog/[slug]` pages
 * were never covered by `revalidatePath("/blog")`, so publishing an edit left
 * every individual post page serving its old copy until its own 5-minute TTL
 * expired.
 *
 * `updateTag` rather than `revalidateTag`: both are valid here, but only
 * `updateTag` gives read-your-own-writes, and it is callable only from a Server
 * Action — which is what these are. `revalidateTag(tag, profile)` expires the
 * entry and lets the *next* request refill it, so the person who just clicked
 * "Revalidate now" could still be served the stale copy they were trying to
 * clear. That would make the demo look broken while behaving as documented.
 */

/**
 * Targets callers may invalidate, and the tags each maps to.
 *
 * Still an allowlist, for the same reason the path version was one: this action
 * is reachable by anyone who can reach the page, so the argument must not be
 * able to name an arbitrary cache tag.
 */
const TARGETS = {
  "/blog": [BLOG_POSTS_TAG],
} as const satisfies Record<string, readonly string[]>;

export type RevalidateTarget = keyof typeof TARGETS;

export async function revalidateBlogAction(
  target: string,
): Promise<ActionResult<{ path: string; tags: string[] }>> {
  if (!isTarget(target)) {
    return err(`"${target}" is not a revalidation target.`);
  }

  const tags = [...TARGETS[target]];
  for (const tag of tags) {
    updateTag(tag);
  }

  return ok({ path: target, tags });
}

/**
 * Invalidates a single post plus the list it appears in.
 *
 * Separate from the action above because it takes an id rather than a fixed
 * target, and ids are not an allowlist — this is called by the post mutations,
 * not from the browser.
 */
export async function revalidatePost(id: string): Promise<void> {
  updateTag(blogPostTag(id));
  updateTag(BLOG_POSTS_TAG);
}

function isTarget(value: string): value is RevalidateTarget {
  return Object.hasOwn(TARGETS, value);
}
