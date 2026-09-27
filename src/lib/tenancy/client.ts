// The tenant-scoped client is the pooled client with a scope attached, so this
// module holds a connection to the database exactly as `@/lib/prisma` does.
// See docs/server-only.md.
import "server-only";

import { prisma } from "@/lib/prisma";
import { assertScopeId, TENANT_GUC, USER_GUC } from "@/lib/tenancy/scope";
import type { TenantScope } from "@/lib/tenancy/scope";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * The tenant-scoped Prisma client.
 *
 * ## What it is
 *
 * The same `PrismaClient` as everywhere else, extended so that every operation
 * on every model runs inside a transaction whose first two statements tell
 * Postgres which tenant and which user the connection is acting for. The
 * policies in `prisma/rls.sql` read those two settings; nothing else in the
 * application decides what a scoped query can reach.
 *
 * ## Why the scope is a database setting and not a `where` clause
 *
 * Because a `where` clause is something a query can forget. The repository is
 * already full of the careful version — `getEditablePost` filters on
 * `authorId`, `getPublishedPostById` filters on `published` — and the comments
 * on both say why the filter is in the query rather than in the caller. That
 * argument has a limit: it protects the queries that were written with it in
 * mind. The next `findMany` somebody adds to a dashboard component is one
 * missing clause away from reading another customer's rows, and it will pass
 * review, pass its test and pass CI, because in every environment it will ever
 * be run in there is only one tenant's data to return.
 *
 * Row-level security inverts that. The filter is a property of the connection,
 * so a query that forgets it returns nothing rather than everything, and the
 * failure is visible on the first run rather than on the first customer.
 *
 * ## Why every statement is wrapped in a transaction
 *
 * Because `set_config(..., true)` is transaction-local, and transaction-local
 * is the only variant that is safe on a pooled connection. The session-level
 * form (`SET app.tenant_id = …`, or `set_config(..., false)`) survives until
 * the connection is closed, and a pool hands that same connection to the next
 * request — which may be a different tenant, or the public blog. That is not a
 * theoretical ordering problem: with `max: 1` it happens on the very next
 * statement.
 *
 * The cost is one round trip per statement pair and a transaction per read.
 * Measured against the alternative — a per-tenant connection pool, which is
 * the other way to make a session-level setting safe — that is the cheaper
 * mistake: pools do not multiply well, and a deployment with a thousand
 * tenants would hold a thousand idle pools.
 *
 * ## The one thing this cannot do
 *
 * It cannot scope an interactive transaction, because the extension wraps each
 * operation in a transaction of its own and Postgres has no nested ones.
 * `withTenantTransaction` below is that case, and it is the one a mutation
 * wants — see `@/lib/outbox/write`.
 */
export type TenantClient = ReturnType<typeof tenantClient>;

/**
 * The statements that open a scope, as one array, so the two call sites below
 * cannot set one setting and forget the other.
 *
 * `TRUE` is the `is_local` argument and the whole safety property of this
 * module; it is spelled as a literal rather than passed in, because a caller
 * who could choose `false` would be choosing to leak their tenant onto a
 * shared connection.
 *
 * Both values are bind parameters. `set_config`'s first argument — the setting
 * *name* — is a literal from `@/lib/tenancy/scope` and never interpolated,
 * which matters because that one cannot be parameterised in a way that would
 * make a caller-supplied name safe.
 */
function scopeStatements(
  client: Pick<PrismaClient, "$executeRaw">,
  scope: TenantScope,
): [Prisma.PrismaPromise<number>, Prisma.PrismaPromise<number>] {
  return [
    client.$executeRaw`SELECT set_config(${TENANT_GUC}, ${scope.tenantId}, TRUE)`,
    client.$executeRaw`SELECT set_config(${USER_GUC}, ${scope.userId}, TRUE)`,
  ];
}

/**
 * A Prisma client whose every statement is scoped to one tenant.
 *
 * Cheap to construct — `$extends` returns a wrapper over the same pool, not a
 * new connection — so it is built per request rather than cached. Caching one
 * per tenant id would be a map keyed by tenant living for the life of the
 * process, which is the shape `@/lib/request-memo` explains is wrong for
 * per-principal data.
 *
 * The batch form of `$transaction` is what puts the three statements on one
 * connection. The array is ordered and Prisma preserves it, so the settings
 * are in place before the query runs; `query(args)` is the operation the caller
 * asked for, still a `PrismaPromise`, which is why it can go in the array at
 * all.
 */
export function tenantClient(scope: TenantScope) {
  return prisma.$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, , result] = await prisma.$transaction([
            ...scopeStatements(prisma, scope),
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

/**
 * Runs `fn` in one interactive transaction, scoped to a tenant.
 *
 * For a mutation, which is more than one statement and needs them to be one
 * unit: an ownership read and the conditional write that depends on it, plus
 * the outbox rows that must commit with them. Passing a `tenantClient` to that
 * code would give each statement its *own* transaction, which is precisely the
 * property `@/lib/outbox/write` exists to remove.
 *
 * The scope is opened by the first statements inside the transaction, so it
 * covers everything the callback does on `tx` and ends with the transaction —
 * including when the transaction rolls back, which was checked rather than
 * assumed.
 *
 * The callback gets a plain `Prisma.TransactionClient`, deliberately not a
 * scoped one. Inside the transaction the scope is already open; handing back
 * something that would try to open it again would mean an extension wrapping
 * each statement in a nested transaction that Postgres cannot give it.
 */
export async function withTenantTransaction<T>(
  scope: TenantScope,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeout?: number; maxWait?: number },
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Sequential and awaited, not `Promise.all`: they are two statements on
    // one connection and Prisma serialises them anyway, but an un-awaited
    // `set_config` is a scope that may not be open when the first query runs.
    for (const statement of scopeStatements(tx, scope)) await statement;
    return fn(tx);
  }, options);
}

/**
 * The unscoped client, under a name that says so.
 *
 * There are exactly two legitimate unscoped readers and both are named here
 * rather than left to whoever imports `@/lib/prisma`:
 *
 *   - the public blog, which is served to anonymous visitors and prerendered
 *     at build time, and whose reads the `posts_public_read` policy limits to
 *     published rows;
 *   - `@/lib/tenancy/active`, which has to ask which tenants a user may open
 *     before there is a tenant to scope the question to.
 *
 * It is a re-export and not a different client: the protection is the absence
 * of a scope, which the policies already handle. What the name buys is a
 * grep — `scripts/assert-tenant-isolation.ts` rule R5 requires every import of
 * it to carry a comment saying which of the two cases it is, and `@/lib/prisma`
 * itself is off limits to everything but this module and the places that
 * genuinely predate tenancy.
 */
export { prisma as unscopedPrisma };

/**
 * Runs `fn` in a transaction that knows who is asking and deliberately not
 * which tenant they are in.
 *
 * Exactly one read needs this, and it is the one that comes before a scope can
 * exist: "which tenants may this user open". `@/lib/tenancy/active` issues it
 * against `memberships`, whose `memberships_own_read` policy is written in
 * terms of `app.user_id` for this reason — see the comment above it in
 * `prisma/rls.sql` for why that branch is narrower than it looks.
 *
 * The tenant setting is written as the empty string rather than left alone.
 * It is already unset on a fresh transaction, so this changes nothing today;
 * what it does is make the absence deliberate and local, so that a future
 * caller who wraps this in something scoped gets no tenant here rather than
 * inheriting one.
 */
export async function withUserTransaction<T>(
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  assertScopeId(userId, "userId");

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config(${TENANT_GUC}, ${""}, TRUE)`;
    await tx.$executeRaw`SELECT set_config(${USER_GUC}, ${userId}, TRUE)`;
    return fn(tx);
  });
}

/**
 * The name of the setting that opens a draft-mode read.
 *
 * Separate from the two in `@/lib/tenancy/scope` because it is not part of a
 * scope: it does not identify a principal, it names a capability, and it is
 * the only one of the three that widens what a connection can see rather than
 * narrowing it.
 */
export const PREVIEW_GUC = "app.preview";

/**
 * Runs `fn` on an unscoped connection that may read unpublished posts.
 *
 * Draft mode is a whole-site preview — see `docs/draft-mode.md` — so the read
 * behind it has no tenant and has to see rows the `posts_public_read` policy
 * hides. This is that capability, and it is deliberately shaped so that it can
 * only be used on purpose: the policy it satisfies is SELECT-only and requires
 * the absence of a tenant, so a scoped caller cannot reach it and no caller
 * can write through it.
 *
 * It grants exactly what the preview reads already did before row-level
 * security existed. What is new is that it is now the *only* way to reach a
 * draft without a tenant, where previously every query in the application
 * could. See the comment above `posts_preview_read` in `prisma/rls.sql`,
 * including the gap it records.
 */
export async function withPreviewRead<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config(${PREVIEW_GUC}, ${"on"}, TRUE)`;
    return fn(tx);
  });
}
