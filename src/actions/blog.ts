"use server";

import { revalidatePath } from "next/cache";
import { ok, err } from "@/lib/actions";
import type { ActionResult } from "@/lib/actions";

const ALLOWED_PATHS = new Set(["/blog"]);

/**
 * On-demand ISR revalidation for public blog pages.
 * Calls revalidatePath so the next request gets a freshly generated page
 * rather than waiting for the time-based TTL to expire.
 */
export async function revalidateBlogAction(path: string): Promise<ActionResult<{ path: string }>> {
  if (!ALLOWED_PATHS.has(path)) {
    return err(`"${path}" is not a revalidation target.`);
  }
  revalidatePath(path);
  return ok({ path });
}
