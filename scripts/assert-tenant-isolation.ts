/**
 * The tenant-isolation gate.
 *
 * ## Why this one has to touch a database
 *
 * Every other gate in this repository reads the tree or the build output, and
 * that is enough for what they assert. This one cannot be, because the claim
 * is "Postgres will not return another tenant's rows", and there is no
 * arrangement of TypeScript that establishes it. Worse, the ways it fails are
 * all silent:
 *
 *   - the application connects as a superuser, or as a role with BYPASSRLS,
 *     and every policy in `prisma/rls.sql` is skipped with no error anywhere;
 *   - the tables are `ENABLE`d but not `FORCE`d, so the role that ran
 *     `prisma db push` — which in most deployments is the role the application
 *     also connects as — is exempt;
 *   - a policy has a `USING` clause and no `WITH CHECK`, so reads are confined
 *     and a row can still be moved into another tenant by an `UPDATE`;
 *   - a new tenant-scoped table is added to `schema.prisma` and not to
 *     `rls.sql`, so it has no policy at all.
 *
 * In every one of those the application works, the suite passes, and the
 * defect is visible only once a second tenant exists — which in development
 * and in CI it never does. So the gate makes one: two tenants, rows in both,
 * and it measures what a connection scoped to the first can reach.
 *
 * ## Two halves
 *
 * The static rules (R*) read the tree and need nothing. The runtime probes
 * (T*) need a connection and are skipped, loudly, when there is none — a
 * developer running `pnpm db:rls:verify` without a database gets the static
 * half and a message, and CI gets both because CI has a Postgres service.
 *
 * Every rule is exported and checked against the failure it names in
 * `assert-tenant-isolation.test.ts`, by breaking a copy of the tree or by
 * feeding a probe a database that has been sabotaged in exactly that way.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface Finding {
  rule: string;
  where: string;
  message: string;
}

/** The policy file and the schema it has to keep up with. */
export const RLS_FILE = "prisma/rls.sql";
export const SCHEMA_FILE = "prisma/schema.prisma";

/**
 * Modules allowed to import `@/lib/prisma` directly.
 *
 * Everything else goes through `@/lib/tenancy/client`, whose exports say which
 * access world they are — `tenantClient`, `unscopedPrisma`, `withPreviewRead`.
 * That is the whole point of R3: `prisma.post.findMany` reads as an ordinary
 * query and is an unscoped one, and the import is the only place the
 * difference is visible.
 */
export const DIRECT_PRISMA_IMPORTERS: readonly { file: string; why: string }[] =
  [
    {
      file: "src/lib/tenancy/client.ts",
      why: "builds every scoped client there is; it is the module R3 exists to funnel imports into",
    },
    {
      file: "src/lib/tenancy/enforcement.ts",
      why: "asks the database about the connection itself, which is not a row and has no tenant",
    },
    {
      file: "src/auth.ts",
      why: "hands the singleton to `PrismaAdapter`, which owns its own queries against untenanted auth tables",
    },
    {
      file: "src/lib/actions/idempotency-store.ts",
      why: "`idempotency_keys` is scoped by its own `scope` column — `user:<id>`, deliberately not a tenant — and carries no tenant column",
    },
    {
      file: "src/lib/auth/registry.ts",
      why: "`session_families` belongs to a user across every workspace they are in; scoping it to one would make a sign-out tenant-specific",
    },
    {
      file: "src/lib/outbox/store.ts",
      why: "`outbox_events` carries no tenant, and the relay that drains it runs with no session at all",
    },
  ];

/**
 * Where an unscoped or preview read is allowed, and why.
 *
 * Shaped like `FETCH_CALL_SITES` in `assert-owasp-checklist.ts`, and for the
 * same reason: the list is short enough to read, and an entry whose reason is
 * "it needed to see everything" is a finding no gate can make for you.
 */
export const UNSCOPED_READERS: readonly { file: string; why: string }[] = [
  {
    file: "src/lib/dal/posts.ts",
    why: "the public blog's three reads, which `posts_public_read` confines to published rows, plus the draft-mode list, which `posts_preview_read` confines to the one workspace its token named",
  },
  {
    file: "src/lib/dal/users.ts",
    why: "`users` has no tenant column and no policy: a person is a member of several workspaces, not owned by one",
  },
  {
    file: "src/lib/dal/loaders.ts",
    why: "the user batch loader (untenanted) and the post batch loader, which takes the previewing workspace rather than reading across all of them",
  },
  {
    file: "src/lib/outbox/write.ts",
    why: "`outbox_events` carries no tenant; the relay that drains it has no session to be scoped by",
  },
  {
    file: "src/lib/tenancy/provision.ts",
    why: "creating a tenant is the one operation that cannot happen inside one",
  },
  {
    file: "src/actions/auth.ts",
    why: "registration runs before the account, and therefore any workspace, exists",
  },
  {
    file: "src/lib/auth/password-upgrade.ts",
    why: "a password belongs to a person and not to one of their workspaces, so the rehash writes `users` — untenanted, the same table and the same client registration writes the first hash through",
  },
  {
    file: "src/lib/auth/password-change.ts",
    why: "the same two untenanted tables the rehash and the sign-out already write: `users` for the hash and `session_families` for the revocation, both of which belong to a person across every workspace they are in. Scoping either would make changing a password — and the sign-out it performs — apply to one workspace",
  },
];

// ---------------------------------------------------------------------------
// Static rules
// ---------------------------------------------------------------------------

/** Models in `schema.prisma` that carry a `tenantId`, plus their table names. */
export function tenantScopedTables(
  schema: string,
): { model: string; table: string }[] {
  const found: { model: string; table: string }[] = [];

  // One pass over `model X { … }` blocks. A regex over the whole file would
  // match a `tenantId` in one model and an `@@map` in the next.
  for (const match of schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const [, model = "", body = ""] = match;
    if (!/^\s*tenantId\s+String/m.test(body)) continue;

    const mapped = /@@map\("([^"]+)"\)/.exec(body);
    found.push({ model, table: mapped?.[1] ?? model });
  }

  return found;
}

/**
 * R1 — every table with a `tenantId` has RLS enabled, forced, and a policy.
 *
 * The rule the whole file is for. Adding a tenant-scoped model to
 * `schema.prisma` is one line; `prisma db push` creates the table with RLS
 * off, and nothing else notices. The `FORCE` half is checked separately
 * because it is the one people leave out — `ENABLE` alone reads as done and
 * exempts the table's owner.
 */
export function policiesCoverSchema(root: string): Finding[] {
  const findings: Finding[] = [];
  const schemaPath = path.join(root, SCHEMA_FILE);
  const rlsPath = path.join(root, RLS_FILE);

  if (!existsSync(schemaPath)) {
    return [{ rule: "R1", where: SCHEMA_FILE, message: "does not exist." }];
  }
  if (!existsSync(rlsPath)) {
    return [
      {
        rule: "R1",
        where: RLS_FILE,
        message:
          "does not exist, so no table has a policy. Row-level security is " +
          "the whole of the tenant boundary; without this file the `tenantId` " +
          "columns are documentation.",
      },
    ];
  }

  const rls = readFileSync(rlsPath, "utf8");
  const tables = tenantScopedTables(readFileSync(schemaPath, "utf8"));

  if (tables.length === 0) {
    findings.push({
      rule: "R1",
      where: SCHEMA_FILE,
      message:
        "declares no model with a `tenantId`, so this gate is measuring " +
        "nothing. Either tenancy was removed, or the column was renamed and " +
        "this rule can no longer find it.",
    });
  }

  for (const { model, table } of tables) {
    const enabled = new RegExp(
      `ALTER\\s+TABLE\\s+(?:public\\.)?${table}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
      "i",
    ).test(rls);
    const forced = new RegExp(
      `ALTER\\s+TABLE\\s+(?:public\\.)?${table}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
      "i",
    ).test(rls);
    const policied = new RegExp(
      `CREATE\\s+POLICY\\s+\\w+\\s+ON\\s+(?:public\\.)?${table}\\b`,
      "i",
    ).test(rls);

    if (!enabled) {
      findings.push({
        rule: "R1",
        where: `${SCHEMA_FILE}:${model}`,
        message:
          `has a \`tenantId\` and \`${table}\` has no ENABLE ROW LEVEL SECURITY in ${RLS_FILE}. ` +
          "The column marks the row's owner and nothing enforces it, so every " +
          "query reaches every tenant's rows.",
      });
    }

    if (enabled && !forced) {
      findings.push({
        rule: "R1",
        where: `${RLS_FILE}:${table}`,
        message:
          "is ENABLEd but not FORCEd. Policies are skipped for the table's " +
          "owner, which under `prisma db push` is whichever role ran the " +
          "push — commonly the same role the application connects as. " +
          `Add \`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;\`.`,
      });
    }

    if (!policied) {
      findings.push({
        rule: "R1",
        where: `${RLS_FILE}:${table}`,
        message:
          "has row-level security enabled and no policy. That is not a " +
          "half-measure: with RLS on and no policy matching, the table " +
          "returns no rows to anybody, which fails closed and breaks the app.",
      });
    }
  }

  return findings;
}

/**
 * R2 — the setting names in TypeScript are the ones the policies read.
 *
 * Two files, one string, and a mismatch has no symptom: `set_config` writes a
 * setting nothing reads, `current_setting(…, true)` returns NULL for a setting
 * nothing wrote, and every scoped query quietly becomes an unscoped one.
 */
export function gucNamesAgree(root: string): Finding[] {
  const findings: Finding[] = [];
  const scopePath = path.join(root, "src/lib/tenancy/scope.ts");
  const rlsPath = path.join(root, RLS_FILE);

  if (!existsSync(scopePath) || !existsSync(rlsPath)) {
    return [
      {
        rule: "R2",
        where: "src/lib/tenancy/scope.ts",
        message: "does not exist, so the setting names cannot be compared.",
      },
    ];
  }

  const scope = readFileSync(scopePath, "utf8");
  const rls = readFileSync(rlsPath, "utf8");

  // `PREVIEW_GUC` is in this list because it was not, and that is where it was
  // needed. It lived in `@/lib/tenancy/client` while the preview capability was
  // the string `'on'`, outside the one rule that compares a name against the
  // policy file. When the capability acquired a tenant, a misspelling stopped
  // being "the capability does nothing" and became "the capability names no
  // workspace", which is the same symptom as a stale cache and no error
  // anywhere. The constant moved into `scope.ts` to be covered here.
  for (const constant of ["TENANT_GUC", "USER_GUC", "PREVIEW_GUC"]) {
    const declared = new RegExp(`${constant}\\s*=\\s*["']([^"']+)["']`).exec(
      scope,
    )?.[1];

    if (!declared) {
      findings.push({
        rule: "R2",
        where: `src/lib/tenancy/scope.ts:${constant}`,
        message:
          "is not declared as a string literal, so it cannot be compared to the policy file.",
      });
      continue;
    }

    if (!rls.includes(`'${declared}'`)) {
      findings.push({
        rule: "R2",
        where: `${RLS_FILE}`,
        message:
          `never reads \`${declared}\`, which \`${constant}\` says every scoped ` +
          "statement writes. A setting nothing reads is a scope that does nothing.",
      });
    }
  }

  return findings;
}

/** Every `.ts`/`.tsx` file under `src`, with its repo-relative path. */
export function collectSources(
  root: string,
): { relativePath: string; text: string }[] {
  const out: { relativePath: string; text: string }[] = [];
  const base = path.join(root, "src");
  if (!existsSync(base)) return out;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      out.push({
        relativePath: path.relative(root, full).split(path.sep).join("/"),
        text: readFileSync(full, "utf8"),
      });
    }
  };

  walk(base);
  return out;
}

/**
 * R3 — nothing imports the Prisma singleton except the enumerated modules.
 *
 * `prisma.post.findMany(…)` is an unscoped query that reads exactly like a
 * scoped one. Routing every caller through `@/lib/tenancy/client` makes the
 * access world a thing you can see at the import, which is the only place it
 * is visible at all.
 */
export function directPrismaImports(root: string): Finding[] {
  const findings: Finding[] = [];
  const allowed = new Set(DIRECT_PRISMA_IMPORTERS.map((entry) => entry.file));
  const found = new Set<string>();

  for (const file of collectSources(root)) {
    if (!/from\s+["']@\/lib\/prisma["']/.test(file.text)) continue;
    found.add(file.relativePath);
    if (allowed.has(file.relativePath)) continue;

    findings.push({
      rule: "R3",
      where: file.relativePath,
      message:
        "imports `@/lib/prisma` directly. Every query in this application " +
        "belongs to one of three access worlds, and the import is where that " +
        "is visible: `tenantClient` for a workspace's rows, `unscopedPrisma` " +
        "for the public blog and the untenanted tables, `withPreviewRead` for " +
        "draft mode. If this really is untenanted, add it to " +
        "`DIRECT_PRISMA_IMPORTERS` with the reason.",
    });
  }

  for (const entry of DIRECT_PRISMA_IMPORTERS) {
    if (found.has(entry.file)) continue;
    findings.push({
      rule: "R3",
      where: entry.file,
      message:
        "is listed in `DIRECT_PRISMA_IMPORTERS` and no longer imports " +
        "`@/lib/prisma`. A stale entry is a hole waiting for a file of that name.",
    });
  }

  return findings;
}

/**
 * R4 — every unscoped or preview reader is on the list, with a reason.
 *
 * The mirror of R3. R3 stops a module reaching the singleton; this one makes
 * sure that reaching for the *named* escape hatch is equally deliberate, since
 * `unscopedPrisma.post.findMany` is as unscoped as `prisma.post.findMany` and
 * only says so.
 *
 * Comments are stripped first, for the reason R6 strips them from the policy
 * file: the modules in this repository explain themselves at length, and naming
 * `withPreviewRead` in a paragraph about why a read does *not* use it was
 * reported as a use of it. Two such findings arrived the first time the preview
 * capability's own argument was written down, in `@/lib/cache/blog` and
 * `@/lib/preview/token` — neither of which touches a database. A gate that makes
 * prose unwritable gets its prose deleted.
 */
export function unscopedReaders(root: string): Finding[] {
  const findings: Finding[] = [];
  const allowed = new Set(UNSCOPED_READERS.map((entry) => entry.file));
  const found = new Set<string>();

  for (const file of collectSources(root)) {
    // The client module exports them; importing itself is not a use.
    if (file.relativePath === "src/lib/tenancy/client.ts") continue;
    if (
      !/\b(unscopedPrisma|withPreviewRead)\b/.test(withoutComments(file.text))
    )
      continue;

    found.add(file.relativePath);
    if (allowed.has(file.relativePath)) continue;

    findings.push({
      rule: "R4",
      where: file.relativePath,
      message:
        "reads outside a tenant scope and is not in `UNSCOPED_READERS`. An " +
        "unscoped read sees every tenant's published rows; a preview read " +
        "sees their drafts. Add it with the reason its data is not " +
        "tenant-owned — and if the reason is that a tenant was inconvenient " +
        "to obtain, this is the finding the gate exists for.",
    });
  }

  for (const entry of UNSCOPED_READERS) {
    if (found.has(entry.file)) continue;
    findings.push({
      rule: "R4",
      where: entry.file,
      message:
        "is listed in `UNSCOPED_READERS` and no longer reads unscoped. A " +
        "stale entry is a hole waiting for a file of that name.",
    });
  }

  return findings;
}

/**
 * A module's source with its comment-only lines removed.
 *
 * Line-based and deliberately crude: a line whose first non-space characters are
 * `//`, `/*`, `*` or `*​/` is dropped, and nothing else is touched. That covers
 * every JSDoc block and every standalone comment, which is where prose lives,
 * and it cannot remove code — a scanner that tried to strip a trailing `//`
 * comment has to decide whether the `//` in `"https://…"` is one, and getting
 * that wrong deletes the statement beside it.
 *
 * The limit, stated rather than discovered: a trailing comment on a line of code
 * is still scanned. That direction is the safe one — the rule over-reports and
 * never fails open — and the fix for such a report is to move the sentence onto
 * its own line.
 */
function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*")
      );
    })
    .join("\n");
}

/**
 * R5 — every Server Action that writes passes a scope to `writeWithOutbox`.
 *
 * A write with no scope is refused by the database rather than landing in the
 * wrong tenant, so this rule is about the error arriving in CI instead of in
 * production. It is deliberately narrow: it looks at `src/actions/`, where
 * every writer has a request and therefore a tenant.
 */
export function scopedActionWrites(root: string): Finding[] {
  const findings: Finding[] = [];
  const dir = path.join(root, "src/actions");
  if (!existsSync(dir)) return findings;

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;

    const relativePath = `src/actions/${entry}`;
    const text = readFileSync(path.join(dir, entry), "utf8");

    const calls = text.match(/writeWithOutbox\(/g)?.length ?? 0;
    if (calls === 0) continue;

    const scoped = text.match(/scope:\s*\w+\.scope\b/g)?.length ?? 0;
    if (scoped >= calls) continue;

    findings.push({
      rule: "R5",
      where: relativePath,
      message:
        `calls \`writeWithOutbox\` ${calls} time(s) and passes a \`scope\` ` +
        `${scoped} time(s). A write with no scope opens no tenant, and the ` +
        "policies give an unscoped connection no INSERT, UPDATE or DELETE — " +
        "so it fails at runtime, on the first mutation, in production.",
    });
  }

  return findings;
}

/**
 * R6 — no `app.*` function is used above its own definition.
 *
 * `prisma/rls.sql` is sent to Postgres as one multi-statement query, so a
 * policy whose predicate calls a function the file has not defined yet fails
 * outright: `function app.current_user_id() does not exist`.
 *
 * The reason this needs a rule rather than care is that it is invisible on
 * every database that matters to the person making the mistake. Re-applying
 * the file to a database that already has the function succeeds, every time —
 * so the author sees green locally and the build breaks on the one database
 * that was fresh, which is CI's. That is exactly what happened when
 * `tenants_member_read` was added: it referenced `app.current_user_id()`
 * thirty lines above the `CREATE OR REPLACE FUNCTION` that defines it.
 *
 * The check is positional and deliberately crude — first definition versus
 * first use, by character offset. A file that defines everything up front,
 * which is now the convention here, passes trivially.
 */
export function functionsDefinedBeforeUse(root: string): Finding[] {
  const findings: Finding[] = [];
  const rlsPath = path.join(root, RLS_FILE);
  if (!existsSync(rlsPath)) return findings;

  // Comments are stripped first: this file explains itself at length, and a
  // function named in a paragraph above its definition is prose, not a call.
  const sql = readFileSync(rlsPath, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  const defined = new Map<string, number>();
  for (const match of sql.matchAll(
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+app\.(\w+)\s*\(/gi,
  )) {
    if (!defined.has(match[1] ?? "")) {
      defined.set(match[1] ?? "", match.index ?? 0);
    }
  }

  const seen = new Set<string>();
  for (const match of sql.matchAll(/\bapp\.(\w+)\s*\(/g)) {
    const name = match[1] ?? "";
    const at = match.index ?? 0;
    if (seen.has(name)) continue;

    const definedAt = defined.get(name);

    // A definition is itself a use by this regex; skip the one that *is* the
    // definition, and only then record that we have seen this name.
    if (definedAt === at) {
      seen.add(name);
      continue;
    }

    seen.add(name);

    if (definedAt === undefined) {
      findings.push({
        rule: "R6",
        where: `${RLS_FILE}:app.${name}`,
        message:
          "is called by a policy and never defined in this file. The whole " +
          "file is one multi-statement query, so this fails on apply.",
      });
      continue;
    }

    if (at < definedAt) {
      findings.push({
        rule: "R6",
        where: `${RLS_FILE}:app.${name}`,
        message:
          "is used before it is defined. The file is applied as one " +
          "multi-statement query, so this fails with `function app." +
          `${name}() does not exist\` — but only on a database that does not ` +
          "already have it, which means every local re-apply passes and CI's " +
          "fresh database is the one that breaks. Define it in the accessor " +
          "section at the top.",
      });
    }
  }

  return findings;
}

export function staticFindings(root: string): Finding[] {
  return [
    ...policiesCoverSchema(root),
    ...gucNamesAgree(root),
    ...directPrismaImports(root),
    ...unscopedReaders(root),
    ...scopedActionWrites(root),
    ...functionsDefinedBeforeUse(root),
  ];
}

// ---------------------------------------------------------------------------
// Runtime probes
// ---------------------------------------------------------------------------

/**
 * The slice of a `pg` client these probes need.
 *
 * An interface rather than the class, so the unit test can drive the probes
 * against a recorded database and CI can drive them against a real one. The
 * probes issue their own `BEGIN`/`ROLLBACK`, because a scope is
 * transaction-local and a probe that did not control its transaction would be
 * measuring the pool's behaviour rather than the policy's.
 */
export interface SqlClient {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/** The two tenants and four rows every probe below is written against. */
export const FIXTURE = {
  tenantA: "rls-probe-tenant-a",
  tenantB: "rls-probe-tenant-b",
  userA: "rls-probe-user-a",
  userB: "rls-probe-user-b",
  draftA: "rls-probe-post-a-draft",
  publicA: "rls-probe-post-a-public",
  draftB: "rls-probe-post-b-draft",
  publicB: "rls-probe-post-b-public",
} as const;

/**
 * Inserts the fixture, on an administrative connection.
 *
 * Administrative because creating a tenant cannot be done inside a tenant
 * scope, and because the fixture has to exist regardless of what the policies
 * say — a fixture the policies could refuse would make a broken policy look
 * like a passing gate with no rows in it.
 */
export async function seedFixture(admin: SqlClient): Promise<void> {
  await removeFixture(admin);

  await admin.query(
    `INSERT INTO tenants (id, slug, name, "createdAt", "updatedAt")
     VALUES ($1, $2, 'RLS Probe A', now(), now()), ($3, $4, 'RLS Probe B', now(), now())`,
    [
      FIXTURE.tenantA,
      `${FIXTURE.tenantA}-slug`,
      FIXTURE.tenantB,
      `${FIXTURE.tenantB}-slug`,
    ],
  );

  await admin.query(
    `INSERT INTO users (id, email, role, "createdAt", "updatedAt")
     VALUES ($1, $2, 'USER', now(), now()), ($3, $4, 'USER', now(), now())`,
    [
      FIXTURE.userA,
      `${FIXTURE.userA}@example.test`,
      FIXTURE.userB,
      `${FIXTURE.userB}@example.test`,
    ],
  );

  await admin.query(
    `INSERT INTO memberships (id, "userId", "tenantId", role, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'OWNER', now(), now()), ($4, $5, $6, 'OWNER', now(), now())`,
    [
      `${FIXTURE.userA}-m`,
      FIXTURE.userA,
      FIXTURE.tenantA,
      `${FIXTURE.userB}-m`,
      FIXTURE.userB,
      FIXTURE.tenantB,
    ],
  );

  await admin.query(
    `INSERT INTO posts (id, title, published, version, "authorId", "tenantId", "createdAt", "updatedAt")
     VALUES ($1, 'A draft', false, 1, $2, $3, now(), now()),
            ($4, 'A public', true, 1, $2, $3, now(), now()),
            ($5, 'B draft', false, 1, $6, $7, now(), now()),
            ($8, 'B public', true, 1, $6, $7, now(), now())`,
    [
      FIXTURE.draftA,
      FIXTURE.userA,
      FIXTURE.tenantA,
      FIXTURE.publicA,
      FIXTURE.draftB,
      FIXTURE.userB,
      FIXTURE.tenantB,
      FIXTURE.publicB,
    ],
  );
}

export async function removeFixture(admin: SqlClient): Promise<void> {
  // Tenants cascade to posts and memberships; users are deleted explicitly
  // because a user is not owned by a tenant.
  await admin.query(`DELETE FROM tenants WHERE id = ANY($1)`, [
    [FIXTURE.tenantA, FIXTURE.tenantB],
  ]);
  await admin.query(`DELETE FROM users WHERE id = ANY($1)`, [
    [FIXTURE.userA, FIXTURE.userB],
  ]);
}

/** Runs `body` inside a transaction scoped to `tenantId`, then rolls back. */
async function inScope<T>(
  app: SqlClient,
  tenantId: string | null,
  userId: string | null,
  body: () => Promise<T>,
): Promise<T> {
  await app.query("BEGIN");
  try {
    if (tenantId !== null) {
      await app.query("SELECT set_config('app.tenant_id', $1, TRUE)", [
        tenantId,
      ]);
    }
    if (userId !== null) {
      await app.query("SELECT set_config('app.user_id', $1, TRUE)", [userId]);
    }
    return await body();
  } finally {
    // Always rolled back: these probes write, and a gate that leaves rows
    // behind is a gate that passes once.
    await app.query("ROLLBACK");
  }
}

/** The error Postgres raises when a policy refuses a row. `42501`. */
function isPolicyViolation(thrown: unknown): boolean {
  const code = (thrown as { code?: unknown } | null)?.code;
  return (
    code === "42501" ||
    (thrown instanceof Error && thrown.message.includes("row-level security"))
  );
}

/**
 * The probes, in the order a reader should meet them. Each returns its
 * findings; an empty array is a pass.
 *
 * `app` must be the application's own role. Handing this an administrative
 * connection is the mistake T1 exists to catch, and it catches it first.
 */
export async function runtimeFindings(
  app: SqlClient,
  admin: SqlClient,
): Promise<Finding[]> {
  const findings: Finding[] = [];

  // T1 — the connection is actually subject to the policies.
  const bypass = await app.query("SELECT reason FROM app.rls_bypass_reasons()");
  for (const row of bypass.rows) {
    findings.push({
      rule: "T1",
      where: "DATABASE_URL",
      message:
        `${String(row.reason)}. Every policy below is skipped for this ` +
        "connection, so the rest of this gate would pass against a database " +
        "with no isolation at all.",
    });
  }

  // A bypassing connection makes every remaining probe meaningless — it would
  // report "sees 4 rows" for reasons that have nothing to do with the policy
  // being wrong — so stop here rather than printing four misleading findings.
  if (findings.length > 0) return findings;

  await seedFixture(admin);

  try {
    // T2 — a scoped connection sees its own tenant's rows and only those.
    await inScope(app, FIXTURE.tenantA, FIXTURE.userA, async () => {
      const seen = await app.query(
        "SELECT id FROM posts WHERE id LIKE 'rls-probe-%' ORDER BY id",
      );
      const ids = seen.rows.map((row) => String(row.id));
      const expected = [FIXTURE.draftA, FIXTURE.publicA].sort();

      if (JSON.stringify(ids) !== JSON.stringify(expected)) {
        findings.push({
          rule: "T2",
          where: "posts",
          message:
            `a connection scoped to tenant A saw [${ids.join(", ")}] where it ` +
            `should have seen [${expected.join(", ")}]. ` +
            (ids.includes(FIXTURE.publicB)
              ? "It can read another tenant's published rows, which means the " +
                "public-read policy is missing its `app.current_tenant_id() IS NULL` conjunct."
              : "Tenant isolation on `posts` is not in effect."),
        });
      }
    });

    // T3 — a scoped UPDATE cannot reach another tenant's row.
    await inScope(app, FIXTURE.tenantA, FIXTURE.userA, async () => {
      const updated = await app.query(
        "UPDATE posts SET title = 'taken' WHERE id = $1",
        [FIXTURE.draftB],
      );

      if ((updated.rowCount ?? 0) !== 0) {
        findings.push({
          rule: "T3",
          where: "posts",
          message:
            "a connection scoped to tenant A updated tenant B's row. The " +
            "`USING` clause of `posts_tenant_scope` is what bounds which rows " +
            "an UPDATE can find, and it is not doing it.",
        });
      }
    });

    // T4 — a row cannot be moved out of its tenant.
    await inScope(app, FIXTURE.tenantA, FIXTURE.userA, async () => {
      try {
        await app.query('UPDATE posts SET "tenantId" = $1 WHERE id = $2', [
          FIXTURE.tenantB,
          FIXTURE.draftA,
        ]);
        findings.push({
          rule: "T4",
          where: "posts",
          message:
            "a scoped connection moved one of its own rows into another " +
            "tenant. That passes the read filter on the way in and is a " +
            "cross-tenant write on the way out — it is what `WITH CHECK` is " +
            "for, and a policy with only `USING` allows it.",
        });
      } catch (thrown) {
        if (!isPolicyViolation(thrown)) throw thrown;
      }
    });

    // T5 — an unscoped connection is the public blog: published rows only.
    await inScope(app, null, null, async () => {
      const seen = await app.query(
        "SELECT id FROM posts WHERE id LIKE 'rls-probe-%' ORDER BY id",
      );
      const ids = seen.rows.map((row) => String(row.id));
      const expected = [FIXTURE.publicA, FIXTURE.publicB].sort();

      if (JSON.stringify(ids) !== JSON.stringify(expected)) {
        findings.push({
          rule: "T5",
          where: "posts",
          message:
            `an unscoped connection saw [${ids.join(", ")}] where the public ` +
            `blog should see [${expected.join(", ")}]. ` +
            (ids.includes(FIXTURE.draftA) || ids.includes(FIXTURE.draftB)
              ? "It can read unpublished posts without opening draft mode."
              : "The public blog cannot read its own content."),
        });
      }
    });

    // T6 — an unscoped connection cannot write at all.
    await inScope(app, null, null, async () => {
      try {
        await app.query(
          `INSERT INTO posts (id, title, published, version, "authorId", "tenantId", "createdAt", "updatedAt")
           VALUES ('rls-probe-escape', 'escape', false, 1, $1, $2, now(), now())`,
          [FIXTURE.userA, FIXTURE.tenantA],
        );
        findings.push({
          rule: "T6",
          where: "posts",
          message:
            "an unscoped connection inserted a row. A write that forgot to " +
            "open a tenant scope must be refused by the database; there is no " +
            "INSERT policy that should match here.",
        });
      } catch (thrown) {
        if (!isPolicyViolation(thrown)) throw thrown;
      }
    });

    // T7 — draft mode is the public site plus *one* workspace's drafts.
    //
    // The probe this item rewrote, and the expectation is narrower than it
    // looks in both directions. It used to assert all four rows, which was the
    // gap: `posts_preview_read` tested a boolean, so a token minted inside
    // tenant A opened tenant B's drafts too.
    //
    // What replaced it is not "tenant A's rows" either, and the first draft of
    // this probe asserted exactly that and failed — correctly. `/blog` is the
    // *public* blog and the public blog is deliberately cross-tenant:
    // `getPublishedPosts` reads unscoped, so every workspace's published posts
    // are already on it, for anonymous visitors, with no preview involved. A
    // preview of that page is the question "how would this look once my drafts
    // were published", so the right answer is the public view **plus** tenant
    // A's unpublished rows — three of the four. `posts_public_read` ORs in to
    // supply the first part, which is the policy working rather than leaking:
    // `publicB` is a row anybody can read without a token.
    //
    // So the whole assertion rests on one exclusion, and it is the only one
    // this item is about: `draftB` must not be there.
    await inScope(app, null, null, async () => {
      await app.query("SELECT set_config('app.preview_tenant_id', $1, TRUE)", [
        FIXTURE.tenantA,
      ]);
      const seen = await app.query(
        "SELECT id FROM posts WHERE id LIKE 'rls-probe-%' ORDER BY id",
      );
      const ids = seen.rows.map((row) => String(row.id));
      const expected = [
        FIXTURE.draftA,
        FIXTURE.publicA,
        FIXTURE.publicB,
      ].sort();

      if (JSON.stringify(ids) !== JSON.stringify(expected)) {
        findings.push({
          rule: "T7",
          where: "posts",
          message:
            `a preview scoped to tenant A saw [${ids.join(", ")}] where it ` +
            `should have seen [${expected.join(", ")}]. ` +
            (ids.includes(FIXTURE.draftB)
              ? "It can read another workspace's drafts, which is the gap " +
                "`posts_preview_read` was tightened to close: its predicate " +
                'must compare `"tenantId"` against `app.preview_tenant_id()` ' +
                "and not merely check that a preview is open."
              : ids.includes(FIXTURE.draftA)
                ? "It sees its own drafts and is missing published rows the " +
                  "public blog already serves, so previewing *subtracts* from " +
                  "the page — check that `posts_public_read` still applies to a " +
                  "connection with the preview capability open."
                : "`posts_preview_read` is not letting the blog's preview " +
                  "branch read an unpublished post at all, so `/blog` in draft " +
                  "mode shows exactly what the public sees."),
        });
      }
    });

    // T12 — a preview that names no workspace reads no draft.
    //
    // The fail-closed half, and the reason the capability and its tenant are one
    // setting. A draft session whose scope cookie is missing, truncated or
    // edited reaches the database with nothing in `app.preview_tenant_id`, and
    // what it must get is the published site — not every workspace's drafts,
    // which is what a boolean capability with an absent tenant would have meant.
    // `"tenantId" = NULL` is NULL rather than true, so this holds by
    // construction; the probe is here because "by construction" is a claim about
    // a predicate somebody can rewrite.
    await inScope(app, null, null, async () => {
      await app.query("SELECT set_config('app.preview_tenant_id', '', TRUE)");
      const seen = await app.query(
        "SELECT id FROM posts WHERE id LIKE 'rls-probe-%' ORDER BY id",
      );
      const ids = seen.rows.map((row) => String(row.id));
      const expected = [FIXTURE.publicA, FIXTURE.publicB].sort();

      if (JSON.stringify(ids) !== JSON.stringify(expected)) {
        findings.push({
          rule: "T12",
          where: "posts",
          message:
            `a preview naming no workspace saw [${ids.join(", ")}] where it ` +
            `should see the published site, [${expected.join(", ")}]. A scope ` +
            "cookie that is absent or does not verify must read like an " +
            "anonymous visitor; `posts_preview_read` matching on the mere " +
            "presence of the setting is how that becomes every workspace's drafts.",
        });
      }
    });

    // T13 — the preview capability cannot widen a tenant scope.
    //
    // The `app.current_tenant_id() IS NULL` conjunct, measured. Without it the
    // dashboard's own connection — which is scoped, and which serves a signed-in
    // member — would be one `set_config` away from reading another workspace,
    // and the setting it would need is one the application writes on a
    // neighbouring code path.
    await inScope(app, FIXTURE.tenantA, FIXTURE.userA, async () => {
      await app.query("SELECT set_config('app.preview_tenant_id', $1, TRUE)", [
        FIXTURE.tenantB,
      ]);
      const seen = await app.query(
        "SELECT id FROM posts WHERE id LIKE 'rls-probe-%' ORDER BY id",
      );
      const ids = seen.rows.map((row) => String(row.id));
      const expected = [FIXTURE.draftA, FIXTURE.publicA].sort();

      if (JSON.stringify(ids) !== JSON.stringify(expected)) {
        findings.push({
          rule: "T13",
          where: "posts",
          message:
            `a connection scoped to tenant A, with the preview capability set ` +
            `to tenant B, saw [${ids.join(", ")}] where it should still see only ` +
            `[${expected.join(", ")}]. \`posts_preview_read\` must require ` +
            "`app.current_tenant_id() IS NULL`, or the capability granted to a " +
            "bearer token also widens every scoped read in the application.",
        });
      }
    });

    // T8 — the scope does not survive its transaction.
    //
    // The property the whole design rests on, and the one that is invisible
    // until a pool reuses a connection. `set_config(…, TRUE)` is
    // transaction-local; the session form is not, and the two are one
    // character apart.
    await inScope(app, FIXTURE.tenantA, FIXTURE.userA, async () => {});
    const leaked = await app.query(
      "SELECT current_setting('app.tenant_id', true) AS value",
    );
    const value = leaked.rows[0]?.value;
    if (value !== null && value !== undefined && value !== "") {
      findings.push({
        rule: "T8",
        where: "app.tenant_id",
        message:
          `is still \`${String(value)}\` after its transaction ended. The scope ` +
          "is leaking onto the pooled connection, so the next request served " +
          "by it — another tenant, or the public blog — inherits this one's " +
          "scope. `set_config` must be called with `TRUE` as its third argument.",
      });
    }

    // T9 — a member cannot enumerate another tenant's memberships.
    await inScope(app, FIXTURE.tenantA, FIXTURE.userA, async () => {
      const seen = await app.query(
        "SELECT id FROM memberships WHERE id LIKE 'rls-probe-%'",
      );

      if (seen.rows.length !== 1) {
        findings.push({
          rule: "T9",
          where: "memberships",
          message:
            `a connection scoped to tenant A saw ${seen.rows.length} membership ` +
            "rows where it should see 1. The table that maps people to " +
            "workspaces answers 'who else uses this product'.",
        });
      }
    });

    // T10 — the membership lookup that precedes a scope sees only its own user.
    await inScope(app, null, FIXTURE.userA, async () => {
      const seen = await app.query(
        `SELECT "userId" FROM memberships WHERE id LIKE 'rls-probe-%'`,
      );
      const users = [...new Set(seen.rows.map((row) => String(row.userId)))];

      if (users.length !== 1 || users[0] !== FIXTURE.userA) {
        findings.push({
          rule: "T10",
          where: "memberships",
          message:
            `the unscoped "which tenants may I open" read returned rows for ` +
            `[${users.join(", ")}]. \`memberships_own_read\` must be limited to ` +
            "`app.user_id`, or that one read becomes a listing of every " +
            "membership in the installation.",
        });
      }
    });

    // T11 — the read that precedes a scope can resolve the tenants it names.
    //
    // Found against a running production build rather than reasoned out.
    // `@/lib/tenancy/active` reads `memberships` with a user and no tenant,
    // joining `tenants` for the slug and name it has to show — and with only
    // an `id = app.current_tenant_id()` policy on `tenants`, that join matched
    // nothing, because there is no tenant yet. A LEFT JOIN against an
    // invisible row is a NULL, not an error, so the failure was
    // `Cannot read properties of null` on every signed-in request, and the
    // unit suite passed throughout: a mocked membership row comes with its
    // tenant attached. `tenants_member_read` is the fix and this is the probe
    // that keeps it.
    await inScope(app, null, FIXTURE.userA, async () => {
      const seen = await app.query(
        `SELECT t.slug FROM memberships m
           JOIN tenants t ON t.id = m."tenantId"
          WHERE m.id LIKE 'rls-probe-%'`,
      );

      if (seen.rows.length !== 1) {
        findings.push({
          rule: "T11",
          where: "tenants",
          message:
            `the "which workspaces may I open" read resolved ${seen.rows.length} ` +
            "tenant row(s) where it should resolve 1. This read happens before " +
            "any tenant scope exists — it is what decides the scope — so a " +
            "`tenants` policy keyed only on `app.current_tenant_id()` hides " +
            "every row from it, and the join yields NULL rather than failing.",
        });
      }
    });
  } finally {
    await removeFixture(admin);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function report(findings: Finding[]): void {
  for (const finding of findings) {
    console.error(`  ✗ [${finding.rule}] ${finding.where} ${finding.message}`);
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  const findings = staticFindings(root);

  const appUrl = process.env.DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL ?? appUrl;

  if (!appUrl) {
    console.error(
      "assert-tenant-isolation: DATABASE_URL is unset, so only the static " +
        "rules ran. The probes are the half that can actually observe a " +
        "missing policy; CI runs them against its Postgres service.",
    );
  } else {
    // Imported here rather than at module scope so the static half, and the
    // unit test, do not need the driver.
    const { Client } = await import("pg");
    const app = new Client({ connectionString: appUrl });
    const admin = new Client({ connectionString: adminUrl });

    await app.connect();
    await admin.connect();
    try {
      findings.push(...(await runtimeFindings(app, admin)));
    } finally {
      await app.end();
      await admin.end();
    }
  }

  if (findings.length > 0) {
    console.error(
      `\nassert-tenant-isolation: ${findings.length} finding(s).\n`,
    );
    report(findings);
    console.error("\nSee docs/multi-tenancy.md.\n");
    process.exit(1);
  }

  console.log(
    appUrl
      ? "assert-tenant-isolation: tenant isolation is enforced (static rules + live probes)."
      : "assert-tenant-isolation: static rules pass; probes skipped (no DATABASE_URL).",
  );
}

/* c8 ignore start -- CLI entry; the rules above are what the tests exercise. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((thrown: unknown) => {
    console.error("assert-tenant-isolation failed to run:", thrown);
    process.exit(1);
  });
}
/* c8 ignore stop */
