// Writes `tenants` and `memberships` through the unscoped connection. See
// docs/server-only.md.
import "server-only";

import { unscopedPrisma } from "@/lib/tenancy/client";
import { isValidSlug, slugify } from "@/lib/tenancy/slug";
import type { Prisma } from "@prisma/client";

/**
 * Creating a tenant, which is the one operation that cannot happen inside one.
 *
 * ## Why it is unscoped, and why that is not a hole
 *
 * A tenant scope is opened by naming an existing tenant, so the statement that
 * brings one into existence has no scope to run in. There is no way around
 * that: it is the bootstrap, and every multi-tenant system has one.
 *
 * What keeps it from being a hole is that `prisma/rls.sql` gives `tenants` a
 * SELECT and an UPDATE policy and deliberately **no INSERT policy**. An
 * unscoped connection can therefore not insert a tenant row at all — so this
 * module cannot be reimplemented by accident somewhere else, and the seam is
 * where the policy file says it is rather than wherever somebody happened to
 * call `prisma.tenant.create`.
 *
 * It follows that provisioning runs on an administrative connection: the seed,
 * a migration, or a deployment's own bootstrap. `registerAction` calls
 * `provisionPersonalTenant` below, and in a deployment where the application
 * role cannot create tenants that call fails loudly at registration rather
 * than half-creating a user. `docs/multi-tenancy.md` sets out the two ways to
 * wire that — a second connection, or a `SECURITY DEFINER` function — and why
 * this repository ships neither by default.
 *
 * ## Why every user gets a tenant
 *
 * Because "signed in but in no workspace" is a state every page downstream
 * would have to render, and there is nothing useful to put on it. A personal
 * tenant created at registration means `getActiveTenant` always has an answer
 * for a user who has one, and the empty case is genuinely exceptional rather
 * than the first thing a new account sees.
 */
export interface ProvisionedTenant {
  readonly tenantId: string;
  readonly slug: string;
}

/**
 * The client a provisioning call runs on.
 *
 * Accepts a transaction client so that registration can create the user, the
 * tenant and the membership as one unit: a user with no membership is an
 * account that cannot open anything, and it is exactly what a failure halfway
 * through this would leave behind.
 */
export type ProvisioningClient = Pick<
  Prisma.TransactionClient,
  "tenant" | "membership"
>;

/**
 * How many times a slug collision is retried before giving up.
 *
 * Collisions are expected — two people called "Acme" both get `acme` — and
 * they are resolved by suffixing, not by failing. The bound exists because the
 * loop's exit condition is a database constraint, and a loop whose exit
 * depends on the database is a loop that must not be unbounded.
 */
const MAX_SLUG_ATTEMPTS = 8;

/**
 * Creates a tenant and its owner's membership, together.
 *
 * The slug is taken from `name` and suffixed on collision. The collision is
 * detected by the unique index rather than by a preceding `findUnique`, for
 * the reason `IdempotencyKey`'s header gives one table over: a read that says
 * "free" and an insert that assumes it are two statements, and two
 * registrations racing for `acme` both pass the read.
 */
export async function provisionTenant(
  client: ProvisioningClient,
  input: { name: string; ownerId: string; slug?: string },
): Promise<ProvisionedTenant> {
  const base = input.slug ?? fallbackSlug(input.name, input.ownerId);

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${suffix()}`;

    try {
      const tenant = await client.tenant.create({
        data: { name: input.name, slug },
        select: { id: true, slug: true },
      });

      await client.membership.create({
        data: { tenantId: tenant.id, userId: input.ownerId, role: "OWNER" },
      });

      return { tenantId: tenant.id, slug: tenant.slug };
    } catch (thrown) {
      // `P2002` is the unique-constraint violation, and it is the only error
      // this loop may swallow. Anything else — a failed connection, a foreign
      // key pointing at a user that does not exist — is not fixed by trying a
      // different slug, and retrying it eight times would turn one error into
      // eight and report the last.
      if (!isUniqueViolation(thrown)) throw thrown;
    }
  }

  throw new Error(
    `Could not find a free slug for "${input.name}" after ${MAX_SLUG_ATTEMPTS} attempts.`,
  );
}

/**
 * The tenant a new account starts in.
 *
 * Named after the person, because it is theirs, and given the `-workspace`
 * suffix so the common case — a personal name that is also somebody else's
 * personal name — collides on something with a little more entropy than a
 * first name.
 */
export async function provisionPersonalTenant(
  client: ProvisioningClient,
  owner: { id: string; name?: string | null; email: string },
): Promise<ProvisionedTenant> {
  const name = owner.name?.trim()
    ? `${owner.name.trim()}'s workspace`
    : "My workspace";
  return provisionTenant(client, { name, ownerId: owner.id });
}

/**
 * A slug for a name that does not reduce to one.
 *
 * `slugify` returns the empty string for a name written in a script with no
 * Latin decomposition, and a reserved word for somebody who called their
 * workspace "admin". Both are ordinary, neither is an error, and the fallback
 * is derived from the owner's id so it is stable for one caller rather than
 * random — which matters only in that a retry produces the same base and the
 * suffix does the work.
 */
function fallbackSlug(name: string, ownerId: string): string {
  const candidate = slugify(name);
  if (isValidSlug(candidate)) return candidate;
  return `w-${ownerId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-10)}`;
}

/** Four hex characters: enough to separate colliding names, short enough to type. */
function suffix(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 4);
}

function isUniqueViolation(thrown: unknown): boolean {
  return (
    typeof thrown === "object" &&
    thrown !== null &&
    (thrown as { code?: unknown }).code === "P2002"
  );
}

/**
 * The unscoped client, for a caller that is provisioning outside a
 * transaction — the seed, and a bootstrap script.
 *
 * Unscoped because creating a tenant cannot be done inside a tenant scope; see
 * this module's header for why that is a seam and not a hole.
 */
export function provisioningClient(): ProvisioningClient {
  return unscopedPrisma;
}
