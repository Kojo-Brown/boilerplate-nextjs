// Reads the database's own catalogue through the application's connection.
// See docs/server-only.md.
import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Is row-level security actually being enforced against this connection?
 *
 * ## Why this exists at all
 *
 * Because the answer can be "no" while everything looks right. RLS is not
 * applied to a superuser, and it is not applied to a role holding BYPASSRLS.
 * Neither is a warning, a notice or an error: the policies are installed,
 * `pg_policies` lists them, `\d posts` prints them, every query succeeds — and
 * every row comes back. A deployment whose `DATABASE_URL` points at `postgres`
 * has precisely as much tenant isolation as one with no policies at all, and
 * there is nothing on any screen to tell the two apart.
 *
 * That is not a hypothetical about somebody else's deployment. It is the
 * default in this repository: `.env.example` ships a `postgres` URL, and CI's
 * Postgres service container has exactly one role. So the first time these
 * policies were applied and the suite run, every test passed and nothing was
 * enforced. `prisma/rls.sql` now creates a dedicated `app_rls` role and CI
 * connects as it; this function is what notices if a deployment does not.
 *
 * ## Why it is a query and not a configuration check
 *
 * Because the property is "what this connection can do", and that is a fact
 * about the role the connection authenticated as, the tables' `FORCE` flags,
 * and the policies — none of which can be read off the URL. `app.rls_bypass_reasons()`
 * asks the database, as the application's own role, and returns one row per
 * reason. Empty means enforced.
 */
export interface RlsEnforcement {
  readonly enforced: boolean;
  /** One sentence per reason the calling role escapes the policies. */
  readonly reasons: readonly string[];
}

interface ReasonRow {
  reason: string;
}

/**
 * Thrown when the policy machinery is not installed.
 *
 * Distinguished from "installed but bypassed" because the two have different
 * fixes and one of them is much more likely to be a fresh checkout: the
 * function is created by `prisma/rls.sql`, so its absence means `pnpm db:rls`
 * has not been run, not that anything is misconfigured.
 */
export class RlsNotInstalledError extends Error {
  constructor(cause: unknown) {
    super(
      "app.rls_bypass_reasons() is missing, so row-level security has not been " +
        "installed on this database. Run `pnpm db:rls` with an administrative " +
        "DATABASE_URL. See docs/multi-tenancy.md.",
      { cause },
    );
    this.name = "RlsNotInstalledError";
  }
}

/** `42883` — undefined_function. The one error that means "not installed". */
const UNDEFINED_FUNCTION = "42883";

/**
 * Asks the database whether its policies bind this connection.
 *
 * Throws `RlsNotInstalledError` when the policy file has never been applied,
 * and otherwise reports — rather than throws — because the two callers want
 * different things from the answer. The CI gate wants every reason so it can
 * print them all; a boot check wants to refuse to start.
 */
export async function readRlsEnforcement(
  client: Pick<typeof prisma, "$queryRaw"> = prisma,
): Promise<RlsEnforcement> {
  let rows: ReasonRow[];

  try {
    rows = await client.$queryRaw<
      ReasonRow[]
    >`SELECT reason FROM app.rls_bypass_reasons()`;
  } catch (thrown) {
    if (isUndefinedFunction(thrown)) throw new RlsNotInstalledError(thrown);
    throw thrown;
  }

  const reasons = rows.map((row) => row.reason);
  return { enforced: reasons.length === 0, reasons };
}

/**
 * Prisma surfaces a driver-adapter error with the SQLSTATE in its `meta`, and
 * the shape differs between the adapter and the query engine — hence a
 * structural check over both rather than an `instanceof`, which would also
 * pull `@prisma/client`'s error classes into a module that otherwise needs
 * only a type.
 */
function isUndefinedFunction(thrown: unknown): boolean {
  if (typeof thrown !== "object" || thrown === null) return false;

  const { code, meta, message } = thrown as {
    code?: unknown;
    meta?: { code?: unknown };
    message?: unknown;
  };

  if (code === UNDEFINED_FUNCTION || meta?.code === UNDEFINED_FUNCTION) {
    return true;
  }

  // The adapter path puts the SQLSTATE in the message text rather than in a
  // field. Matching on it is last, and only alongside the function's own name,
  // so an unrelated `42883` elsewhere in a query cannot be read as this.
  return (
    typeof message === "string" &&
    message.includes(UNDEFINED_FUNCTION) &&
    message.includes("rls_bypass_reasons")
  );
}

/**
 * The same question, as an assertion.
 *
 * For a deployment that would rather not start than serve one customer's rows
 * to another. Not called at module scope anywhere: a top-level `await` against
 * the database in a module the build imports would make `next build` depend on
 * a reachable database at import time, and the build already has a narrower
 * dependency than that. `scripts/assert-tenant-isolation.ts` is where it runs
 * in CI; `docs/multi-tenancy.md` shows the health-check wiring for production.
 */
export async function assertRlsEnforced(
  client?: Pick<typeof prisma, "$queryRaw">,
): Promise<void> {
  const { enforced, reasons } = await readRlsEnforcement(client);
  if (enforced) return;

  throw new Error(
    "Row-level security is installed but not enforced against this " +
      "connection, so tenant isolation is not in effect:\n" +
      reasons.map((reason) => `  - ${reason}`).join("\n") +
      "\nPoint DATABASE_URL at a role that is neither a superuser nor " +
      "BYPASSRLS (prisma/rls.sql creates `app_rls`). See docs/multi-tenancy.md.",
  );
}
