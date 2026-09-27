import { defineAuthedRoute } from "@/lib/api/define-authed-route";
import { ApiError } from "@/lib/api/errors";
import { getActiveTenant } from "@/lib/tenancy/active";
import { getPaginatedPostsByUser } from "@/lib/dal/posts";
import { parseCursorParams } from "@/lib/pagination";
import type { PostSummary } from "@/lib/dal/posts";
import type { CursorPage } from "@/lib/pagination";

/**
 * Cursor-paginated posts for the caller. Node-only for the same reason as
 * `/api/posts`.
 *
 * The query is read with `parseCursorParams` rather than declared as a Zod
 * schema on the spec. That is deliberate: `parseCursorParams` *clamps* —
 * `limit=0` becomes 1, `limit=500` becomes 100, `limit=bad` becomes the default
 * — where a schema would answer 422. Both are defensible, but the clamping
 * behaviour is the one this endpoint already had, it is covered by
 * `src/lib/pagination.test.ts`, and swapping it for rejections here would be a
 * breaking change to an existing client smuggled in under a refactor.
 */
export const GET = defineAuthedRoute<CursorPage<PostSummary>>({
  handler: async ({ request, user }) => {
    // See `/api/posts` for why this is a 403 rather than a redirect.
    const tenant = await getActiveTenant();
    if (!tenant) {
      throw new ApiError("forbidden", "No workspace is open for this request");
    }
    return getPaginatedPostsByUser(
      tenant.tenantId,
      user.id,
      parseCursorParams(request.nextUrl.searchParams),
    );
  },
});
