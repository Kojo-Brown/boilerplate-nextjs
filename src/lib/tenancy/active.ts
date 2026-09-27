// Reads the membership table and the session. See docs/server-only.md.
import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getRequiredSession } from "@/lib/session";
import { requestMemo } from "@/lib/request-memo";
import { withUserTransaction } from "@/lib/tenancy/client";
import { tenantScope } from "@/lib/tenancy/scope";
import type { TenantScope } from "@/lib/tenancy/scope";
import type { TenantRole } from "@prisma/client";

/**
 * Which tenant a request is acting in, and how that is decided.
 *
 * ## The cookie is a request, not an answer
 *
 * The active tenant reaches the server in a cookie, because it has to survive
 * a navigation and it is a preference rather than a URL. What it is *not* is
 * evidence: a cookie is a value the client sends, and every request carrying
 * one is asking to be scoped to that tenant. So it is read, and then it is
 * checked against `memberships` — every request, no exceptions and no cache
 * that outlives one.
 *
 * Signing the cookie would not change that. A signature proves this server
 * issued the value; it says nothing about whether the value is *still* true,
 * and the whole point of checking is that memberships are revoked. A signed
 * tenant cookie is a capability with no expiry, which is the thing it must not
 * be — somebody removed from a workspace would keep their access until they
 * cleared their browser.
 *
 * That is also why the tenant is not a JWT claim, which is the other obvious
 * place to put it and the same mistake in a more durable wrapper. The session
 * token is re-minted only on rotation; a claim in it would go stale for as
 * long as fifteen minutes after a membership was removed, and every layer
 * downstream would be reading a tenant the database no longer agrees with.
 * `@/lib/auth/claims` is deliberately four claims that say nothing about the
 * user, and this would have been the fifth that said a great deal.
 *
 * ## What it costs
 *
 * One indexed read of `memberships` per request that needs a tenant, memoised
 * for the request by `@/lib/request-memo` — so the seven session reads that
 * module's header describes do not become seven membership reads. It is the
 * same trade as the session registry in `@/lib/auth/registry`: a read per
 * request, in exchange for revocation that takes effect on the next one.
 */
export const ACTIVE_TENANT_COOKIE = "active-tenant";

/** A tenant the current user is a member of. */
export interface TenantMembership {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly role: TenantRole;
}

/** The resolved tenant for this request, plus the scope to open it with. */
export interface ActiveTenant extends TenantMembership {
  readonly scope: TenantScope;
}

/**
 * Every tenant this user may open, oldest membership first.
 *
 * Runs through `withUserTransaction`, which sets `app.user_id` and no tenant:
 * this is the read that decides what a tenant scope may be, so it cannot be
 * made inside one. The `memberships_own_read` policy is what limits it to this
 * user's own rows — the `userId` in the `where` below is belt and braces, and
 * is the half that keeps the query honest if the policy is ever widened.
 *
 * `userId` is a string, so this memoises: see the note on argument identity in
 * `@/lib/request-memo`.
 */
export const getMembershipsForUser = requestMemo(
  async (userId: string): Promise<TenantMembership[]> =>
    withUserTransaction(userId, async (tx) => {
      const rows = await tx.membership.findMany({
        where: { userId },
        select: {
          tenantId: true,
          role: true,
          tenant: { select: { slug: true, name: true } },
        },
        orderBy: { createdAt: "asc" },
      });

      return rows.map((row) => ({
        tenantId: row.tenantId,
        slug: row.tenant.slug,
        name: row.tenant.name,
        role: row.role,
      }));
    }),
);

/**
 * Resolves the tenant for this request, or `null` if there is none to resolve.
 *
 * Three outcomes, and the middle one is the reason this is not a one-liner:
 *
 *   - the cookie names a tenant this user is a member of → that tenant;
 *   - the cookie names one they are **not** a member of → `null`, not their
 *     first tenant. Silently falling back would mean a request that explicitly
 *     asked for tenant B is answered with tenant A's data, which is the
 *     wrong-data bug that is hardest to see: every value on the page is real,
 *     and none of it is the workspace the person believes they are looking at.
 *     `getRequiredTenant` turns that into a 403;
 *   - no cookie at all → the user's first tenant, because a fresh sign-in has
 *     no preference yet and every user has at least one (see
 *     `@/lib/tenancy/provision`).
 *
 * Memoised per request. The cookie and the membership table cannot change
 * within one request, and the alternative is this read happening once per
 * component that needs a scope.
 */
export const getActiveTenant = requestMemo(
  async (): Promise<ActiveTenant | null> => {
    const session = await getRequiredSession();
    const memberships = await getMembershipsForUser(session.user.id);
    if (memberships.length === 0) return null;

    const requested = (await cookies()).get(ACTIVE_TENANT_COOKIE)?.value;

    const membership = requested
      ? memberships.find((candidate) => candidate.tenantId === requested)
      : memberships[0];

    if (!membership) return null;

    return {
      ...membership,
      scope: tenantScope(membership.tenantId, session.user.id),
    };
  },
);

/**
 * The tenant for this request, or a 403.
 *
 * `/forbidden` and not `notFound()`: the caller is signed in and the route is
 * real, so "you may not open this workspace" is the accurate answer and the
 * one a person can act on. That is the opposite of the choice `getEditablePost`
 * makes, and deliberately — there, a 404 hides whether a post id exists from
 * somebody probing for them. Here the id came from this user's own cookie, so
 * there is nothing to hide from them that they did not already send.
 *
 * A redirect rather than Next's `forbidden()`, which renders `forbidden.tsx`
 * with a real 403 and would be the better answer. It is gated behind
 * `experimental.authInterrupts`, which this application does not enable, and
 * turning an experimental flag on is not this item's decision to make. This
 * matches `getRequiredAdminSession`, so there is one "you may not" path
 * rather than two.
 */
export async function getRequiredTenant(): Promise<ActiveTenant> {
  const tenant = await getActiveTenant();
  if (!tenant) redirect("/forbidden");
  return tenant;
}

/** The scope on its own, for the callers that only need to open a client. */
export async function getRequiredTenantScope(): Promise<TenantScope> {
  return (await getRequiredTenant()).scope;
}
