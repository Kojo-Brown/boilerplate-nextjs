/**
 * What "the current tenant" is, as a value the database can be told about.
 *
 * Split out from `@/lib/tenancy/client` so that the shape can be constructed,
 * passed and tested without importing Prisma — `@/lib/prisma` is `server-only`
 * and opens a connection pool at module scope, which is a heavy thing to pull
 * into a unit test that only wants to check a predicate.
 */

/**
 * The names the two settings are stored under, and the reason they look like
 * that.
 *
 * A custom GUC must contain a dot; Postgres treats the part before it as an
 * extension-ish namespace and refuses a bare name outright
 * (`invalid configuration parameter name`). `app.` is the conventional prefix
 * and it is what `prisma/rls.sql` reads, so the two have to agree —
 * `scripts/assert-tenant-isolation.ts` compares these constants against the
 * text of the policy file rather than trusting that they do.
 */
export const TENANT_GUC = "app.tenant_id";
export const USER_GUC = "app.user_id";

/**
 * The principal a scoped connection is acting as.
 *
 * Both halves, always. The tenant is what the policies on `posts`, `tenants`
 * and `memberships` test; the user is what the one deliberately unscoped
 * policy (`memberships_own_read`) tests, and it is also the thing an audit of a
 * statement would want. Making `userId` optional would mean every caller
 * deciding whether the connection knows who it is acting for, and the answer
 * inside a request is always "yes".
 */
export interface TenantScope {
  readonly tenantId: string;
  readonly userId: string;
}

/**
 * Thrown when a scope is constructed from something that is not one.
 *
 * The values reach this module from a cookie and from a session, and both are
 * strings that arrived over the network. An empty string is the dangerous one
 * and the reason this check is not merely tidiness: `set_config('app.tenant_id',
 * '', true)` is a *successful* statement, and `app.current_tenant_id()` maps
 * `''` back to NULL — so an empty tenant id does not fail, it silently opens
 * the unscoped, read-published-only view of the database. A dashboard built on
 * that would show an empty workspace rather than an error, which is the kind of
 * bug that gets diagnosed as "the data is missing".
 */
export class InvalidTenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTenantScopeError";
  }
}

/**
 * A length bound, so that a malformed value cannot be pushed into the
 * database's own configuration machinery at arbitrary size. Both ids are cuids
 * (25 characters) with room for a different generator later.
 */
const MAX_ID_LENGTH = 128;

/** Narrows a pair of strings to a `TenantScope`, or throws. */
export function tenantScope(tenantId: string, userId: string): TenantScope {
  assertScopeId(tenantId, "tenantId");
  assertScopeId(userId, "userId");
  return { tenantId, userId };
}

/**
 * Checks one id in isolation.
 *
 * Exported because the membership lookup in `@/lib/tenancy/active` runs with a
 * user and deliberately no tenant — it is the read that decides which tenant
 * the request may open — so it needs half of what `tenantScope` checks and
 * must not be tempted to invent the other half to get it.
 */
export function assertScopeId(value: string, field: string): void {
  if (value.length === 0) {
    throw new InvalidTenantScopeError(
      `A tenant scope needs a non-empty ${field}: the empty string is how a ` +
        "connection says it has no tenant, so scoping to it would silently " +
        "open the unscoped view rather than failing.",
    );
  }

  if (value.length > MAX_ID_LENGTH) {
    throw new InvalidTenantScopeError(
      `A tenant scope's ${field} must be at most ${MAX_ID_LENGTH} characters.`,
    );
  }

  // Rejected rather than escaped. The value is passed as a bind parameter to
  // `set_config`, so nothing here is preventing injection — what it prevents is
  // a scope whose id contains a newline or a null byte being compared for
  // equality against a column that could never hold one, which is an
  // isolation failure that looks like an empty page.
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InvalidTenantScopeError(
      `A tenant scope's ${field} must be an id: letters, digits, "-" and "_" only.`,
    );
  }
}
