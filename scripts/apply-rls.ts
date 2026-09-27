/**
 * Applies `prisma/rls.sql`.
 *
 * A script rather than a line in a README, because the file has to be applied
 * after every `prisma db push` and on every CI build — `db push` reconciles
 * tables and is entirely unaware that policies exist, so a new table arrives
 * with row-level security off and nothing says so.
 *
 * ## Which connection
 *
 * An administrative one. The file creates a role, grants privileges and
 * alters tables, none of which the application's own role can do — and that
 * is the point: a role that could turn these policies off would be a role a
 * compromised application could turn them off with. `DATABASE_ADMIN_URL` if
 * it is set, `DATABASE_URL` otherwise, so a single-role development database
 * needs no extra configuration.
 *
 * ## Why one statement
 *
 * The file is wrapped in `BEGIN`/`COMMIT` and sent as a single multi-statement
 * query, so a failure halfway through leaves the database as it was. A
 * half-applied policy file is the worst of the available states: some tables
 * forced, some not, and a gate that reports whichever it looked at first.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RLS_PATH = "prisma/rls.sql";

/**
 * Sets a password on the application role when one is supplied.
 *
 * `prisma/rls.sql` creates `app_rls` without one, because a password in a
 * committed file is a committed credential. A deployment that connects over
 * TCP needs one, and this is where it is set — from the environment, at apply
 * time, so it never touches the repository.
 *
 * The statement is built with a quoted literal rather than a bind parameter
 * because `ALTER ROLE … PASSWORD` does not accept one; `pg`'s own escaping is
 * used instead of hand-rolled quoting.
 */
export function passwordStatement(
  password: string,
  escape: (value: string) => string,
): string {
  return `ALTER ROLE app_rls PASSWORD ${escape(password)};`;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;

  if (!url) {
    console.error(
      "apply-rls: set DATABASE_ADMIN_URL (or DATABASE_URL) to a connection " +
        "that may create roles and alter tables. See docs/multi-tenancy.md.",
    );
    process.exitCode = 1;
    return;
  }

  const sql = readFileSync(path.join(process.cwd(), RLS_PATH), "utf8");

  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    await client.query(sql);

    const password = process.env.APP_DB_PASSWORD;
    if (password) {
      const { default: pgLib } = await import("pg");
      await client.query(
        passwordStatement(password, (value) => pgLib.escapeLiteral(value)),
      );
      console.log("apply-rls: applied, and set a password on `app_rls`.");
    } else {
      console.log("apply-rls: applied.");
    }
  } finally {
    await client.end();
  }
}

/* c8 ignore start -- CLI entry. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((thrown: unknown) => {
    console.error("apply-rls failed:", thrown);
    process.exit(1);
  });
}
/* c8 ignore stop */
