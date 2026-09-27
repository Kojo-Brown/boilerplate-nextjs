import { defineAuthedRoute } from "@/lib/api/define-authed-route";
import { ApiError } from "@/lib/api/errors";
import { getActiveTenant } from "@/lib/tenancy/active";
import { getPostsByUser } from "@/lib/dal/posts";
import type { PostSummary } from "@/lib/dal/posts";

/**
 * The caller's own posts.
 *
 * Node-only, and honestly so: `defineAuthedRoute` reaches the session through
 * the Prisma adapter and the handler reads Prisma directly. The import list is
 * the whole story — see `src/lib/api/runtimes.ts` for why that is where the
 * runtime boundary is drawn rather than in a segment config.
 *
 * The success payload is unchanged from the hand-written handler this replaces.
 * The failure payload is not: a 401 is now `{ error: { code, message } }` like
 * every other route, rather than this file's own `{ error: "Unauthorized" }`.
 */
export const GET = defineAuthedRoute<PostSummary[]>({
  handler: async ({ user }) => {
    // `getActiveTenant` and not `getRequiredTenant`: the latter redirects,
    // which is the right answer for a page and the wrong one for a JSON
    // endpoint — a client asking for data would be handed a 307 to an HTML
    // page. The error body is the same shape as every other failure here.
    const tenant = await getActiveTenant();
    if (!tenant) {
      throw new ApiError("forbidden", "No workspace is open for this request");
    }
    return getPostsByUser(tenant.tenantId, user.id);
  },
});
