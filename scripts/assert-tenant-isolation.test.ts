import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DIRECT_PRISMA_IMPORTERS,
  FIXTURE,
  UNSCOPED_READERS,
  directPrismaImports,
  functionsDefinedBeforeUse,
  gucNamesAgree,
  policiesCoverSchema,
  runtimeFindings,
  scopedActionWrites,
  staticFindings,
  tenantScopedTables,
  unscopedReaders,
} from "./assert-tenant-isolation";
import type { SqlClient } from "./assert-tenant-isolation";

// ---------------------------------------------------------------------------
// A tree the static rules can be pointed at
// ---------------------------------------------------------------------------

let root: string;

const GOOD_SCHEMA = `
model Post {
  id       String @id
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id])

  @@map("posts")
}

model Tenant {
  id   String @id
  slug String @unique
}
`;

const GOOD_RLS = `
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS text AS $$ SELECT '' $$;
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS text AS $$ SELECT '' $$;
CREATE OR REPLACE FUNCTION app.preview_tenant_id() RETURNS text AS $$ SELECT '' $$;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts FORCE ROW LEVEL SECURITY;
CREATE POLICY posts_tenant_scope ON public.posts
  USING ("tenantId" = app.current_tenant_id());
SELECT current_setting('app.tenant_id', true);
SELECT current_setting('app.user_id', true);
SELECT current_setting('app.preview_tenant_id', true);
`;

const GOOD_SCOPE = `
export const TENANT_GUC = "app.tenant_id";
export const USER_GUC = "app.user_id";
export const PREVIEW_GUC = "app.preview_tenant_id";
`;

function write(relativePath: string, text: string): void {
  const full = path.join(root, relativePath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, text);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "tenancy-gate-"));
  write("prisma/schema.prisma", GOOD_SCHEMA);
  write("prisma/rls.sql", GOOD_RLS);
  write("src/lib/tenancy/scope.ts", GOOD_SCOPE);
});

function cleanup(): void {
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// R1
// ---------------------------------------------------------------------------

describe("tenantScopedTables", () => {
  it("finds models with a tenantId and reads their @@map", () => {
    expect(tenantScopedTables(GOOD_SCHEMA)).toEqual([
      { model: "Post", table: "posts" },
    ]);
  });

  it("falls back to the model name when there is no @@map", () => {
    expect(tenantScopedTables(`model Widget {\n  tenantId String\n}`)).toEqual([
      { model: "Widget", table: "Widget" },
    ]);
  });

  it("does not attribute one model's tenantId to the next model's @@map", () => {
    // A regex over the whole file would. This is the reason the scan is
    // per-block, and the failure would be a gate that checks the wrong table.
    const schema = `
model Untenanted {
  id String @id

  @@map("untenanted")
}

model Scoped {
  tenantId String

  @@map("scoped")
}
`;
    expect(tenantScopedTables(schema)).toEqual([
      { model: "Scoped", table: "scoped" },
    ]);
  });

  it("ignores a model with no tenant column", () => {
    expect(tenantScopedTables(`model User {\n  id String @id\n}`)).toEqual([]);
  });
});

describe("R1 — policies cover the schema", () => {
  it("passes when a tenant-scoped table is enabled, forced and policied", () => {
    expect(policiesCoverSchema(root)).toEqual([]);
    cleanup();
  });

  it("fires when a tenant-scoped table has no RLS at all", () => {
    // The rule the whole file exists for: adding a model with a `tenantId` is
    // one line, and `prisma db push` creates the table with RLS off.
    write(
      "prisma/schema.prisma",
      `${GOOD_SCHEMA}\nmodel Note {\n  tenantId String\n\n  @@map("notes")\n}\n`,
    );

    const findings = policiesCoverSchema(root);

    expect(findings.map((f) => f.rule)).toContain("R1");
    expect(
      findings.some((f) => f.message.includes("ENABLE ROW LEVEL SECURITY")),
    ).toBe(true);
    cleanup();
  });

  it("fires when a table is ENABLEd but not FORCEd", () => {
    // The half people leave out. `ENABLE` alone reads as done and exempts the
    // table's owner, which under `db push` is commonly the application's role.
    write(
      "prisma/rls.sql",
      `ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY p ON public.posts USING (true);
SELECT current_setting('app.tenant_id', true);
SELECT current_setting('app.user_id', true);`,
    );

    const findings = policiesCoverSchema(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("not FORCEd");
    cleanup();
  });

  it("fires when a table is forced with no policy, which fails closed", () => {
    write(
      "prisma/rls.sql",
      `ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts FORCE ROW LEVEL SECURITY;
SELECT current_setting('app.tenant_id', true);
SELECT current_setting('app.user_id', true);`,
    );

    expect(
      policiesCoverSchema(root).some((f) => f.message.includes("no policy")),
    ).toBe(true);
    cleanup();
  });

  it("fires when the policy file is missing entirely", () => {
    rmSync(path.join(root, "prisma/rls.sql"));

    expect(policiesCoverSchema(root)[0]?.message).toContain("does not exist");
    cleanup();
  });

  it("fires when nothing in the schema is tenant-scoped, so the gate measures nothing", () => {
    write("prisma/schema.prisma", `model User {\n  id String @id\n}`);

    expect(policiesCoverSchema(root)[0]?.message).toContain("measuring");
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// R2
// ---------------------------------------------------------------------------

describe("R2 — the setting names agree", () => {
  it("passes when the policy file reads all three settings", () => {
    expect(gucNamesAgree(root)).toEqual([]);
    cleanup();
  });

  it("fires when TypeScript writes a setting the policies never read", () => {
    // A mismatch has no symptom: `set_config` writes a setting nothing reads,
    // `current_setting` returns NULL, and every scoped query becomes unscoped.
    write(
      "src/lib/tenancy/scope.ts",
      GOOD_SCOPE.replace("app.tenant_id", "app.tenant"),
    );

    const findings = gucNamesAgree(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("app.tenant");
    cleanup();
  });

  it("fires when a constant stops being a string literal", () => {
    write(
      "src/lib/tenancy/scope.ts",
      `export const TENANT_GUC = prefix + "tenant_id";\nexport const USER_GUC = "app.user_id";\nexport const PREVIEW_GUC = "app.preview_tenant_id";`,
    );

    expect(gucNamesAgree(root)[0]?.message).toContain("string literal");
    cleanup();
  });

  it("fires when the preview capability's setting is misspelled", () => {
    // The case the rule did not cover, because this constant used to live in
    // `@/lib/tenancy/client` — outside the one file R2 reads. While the
    // capability was a boolean a misspelling merely disabled previews; now it
    // makes every preview name no workspace, which reads as a stale cache.
    write(
      "src/lib/tenancy/scope.ts",
      GOOD_SCOPE.replace("app.preview_tenant_id", "app.preview_tenant"),
    );

    const findings = gucNamesAgree(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("app.preview_tenant");
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// R3 / R4
// ---------------------------------------------------------------------------

describe("R3 — direct Prisma imports", () => {
  it("fires on a module that reaches for the singleton", () => {
    write(
      "src/lib/tenancy/client.ts",
      `import { prisma } from "@/lib/prisma";`,
    );
    write(
      "src/lib/tenancy/enforcement.ts",
      `import { prisma } from "@/lib/prisma";`,
    );
    write("src/auth.ts", `import { prisma } from "@/lib/prisma";`);
    write(
      "src/lib/actions/idempotency-store.ts",
      `import { prisma } from "@/lib/prisma";`,
    );
    write("src/lib/auth/registry.ts", `import { prisma } from "@/lib/prisma";`);
    write("src/lib/outbox/store.ts", `import { prisma } from "@/lib/prisma";`);
    write(
      "src/app/sneaky.ts",
      `import { prisma } from "@/lib/prisma";\nexport const x = prisma;`,
    );

    const findings = directPrismaImports(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "R3",
      where: "src/app/sneaky.ts",
    });
    cleanup();
  });

  it("fires on a stale allowlist entry", () => {
    // An entry for a file that no longer imports Prisma is a hole waiting for
    // a file of that name.
    const findings = directPrismaImports(root);

    expect(findings).toHaveLength(DIRECT_PRISMA_IMPORTERS.length);
    expect(findings.every((f) => f.message.includes("stale"))).toBe(true);
    cleanup();
  });

  it("does not count a test file", () => {
    write("src/lib/thing.test.ts", `import { prisma } from "@/lib/prisma";`);

    expect(
      directPrismaImports(root).some((f) => f.where.endsWith(".test.ts")),
    ).toBe(false);
    cleanup();
  });
});

describe("R4 — unscoped readers", () => {
  it("fires on an unlisted module reading outside a scope", () => {
    for (const entry of UNSCOPED_READERS) {
      write(
        entry.file,
        `import { unscopedPrisma } from "@/lib/tenancy/client";`,
      );
    }
    write(
      "src/app/leaky.ts",
      `import { unscopedPrisma } from "@/lib/tenancy/client";`,
    );

    const findings = unscopedReaders(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "R4",
      where: "src/app/leaky.ts",
    });
    cleanup();
  });

  it("does not count a module that only writes about the capability", () => {
    // The false positive this rule arrived with. `@/lib/cache/blog` and
    // `@/lib/preview/token` both explain, at length, why their reads do or do
    // not take the preview capability — and naming it in that paragraph was
    // reported as taking it. Neither module touches a database. A gate that
    // makes prose unwritable gets its prose deleted, so the comment-only lines
    // are stripped before the scan.
    for (const entry of UNSCOPED_READERS) {
      write(
        entry.file,
        `import { unscopedPrisma } from "@/lib/tenancy/client";`,
      );
    }
    write(
      "src/lib/essay.ts",
      [
        "/**",
        " * Reads nothing. It branches on a scope and leaves `withPreviewRead`",
        " * to the data layer, where `unscopedPrisma` also lives.",
        " */",
        "// withPreviewRead is deliberately not called here.",
        "export const NOTHING = 1;",
      ].join("\n"),
    );

    expect(
      unscopedReaders(root).some((f) => f.where === "src/lib/essay.ts"),
    ).toBe(false);
    cleanup();
  });

  it("counts a preview read as an unscoped one", () => {
    // It is more than unscoped: it can see one workspace's *drafts*, which is
    // more than the public blog gets, and its confinement comes from a policy
    // rather than from a `where` clause.
    for (const entry of UNSCOPED_READERS) {
      write(
        entry.file,
        `import { unscopedPrisma } from "@/lib/tenancy/client";`,
      );
    }
    write(
      "src/app/peek.ts",
      `import { withPreviewRead } from "@/lib/tenancy/client";`,
    );

    expect(
      unscopedReaders(root).some((f) => f.where === "src/app/peek.ts"),
    ).toBe(true);
    cleanup();
  });

  it("does not count the client module's own exports as a use", () => {
    write(
      "src/lib/tenancy/client.ts",
      `export { prisma as unscopedPrisma };\nexport function withPreviewRead() {}`,
    );

    expect(
      unscopedReaders(root).some(
        (f) => f.where === "src/lib/tenancy/client.ts",
      ),
    ).toBe(false);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// R5
// ---------------------------------------------------------------------------

describe("R5 — actions pass a scope to writeWithOutbox", () => {
  it("passes when every call carries one", () => {
    write(
      "src/actions/posts.ts",
      `writeWithOutbox(async () => {}, { scope: tenant.scope });
       writeWithOutbox(async () => {}, { scope: tenant.scope });`,
    );

    expect(scopedActionWrites(root)).toEqual([]);
    cleanup();
  });

  it("fires when a call is missing its scope", () => {
    // The write is refused by the database rather than landing in the wrong
    // tenant, so this rule is about the failure arriving in CI rather than on
    // the first mutation in production.
    write(
      "src/actions/posts.ts",
      `writeWithOutbox(async () => {}, { scope: tenant.scope });
       writeWithOutbox(async () => {});`,
    );

    const findings = scopedActionWrites(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("2 time(s)");
    cleanup();
  });

  it("ignores an action module that writes nothing", () => {
    write("src/actions/preview.ts", `export const x = 1;`);

    expect(scopedActionWrites(root)).toEqual([]);
    cleanup();
  });
});

describe("R6 — app.* functions are defined before they are used", () => {
  it("passes on a file that defines its accessors first", () => {
    write(
      "prisma/rls.sql",
      `CREATE FUNCTION app.current_user_id() RETURNS text AS $$ SELECT '' $$;
CREATE POLICY p ON public.tenants USING (app.current_user_id() IS NOT NULL);`,
    );

    expect(functionsDefinedBeforeUse(root)).toEqual([]);
    cleanup();
  });

  it("fires on the regression that broke the build", () => {
    // `tenants_member_read` referenced `app.current_user_id()` thirty lines
    // above the `CREATE OR REPLACE FUNCTION` defining it. The file is one
    // multi-statement query, so it failed on apply — but only against a
    // database that did not already have the function, which meant every
    // local re-apply passed and CI's fresh Postgres was the one that broke.
    write(
      "prisma/rls.sql",
      `CREATE POLICY p ON public.tenants USING (app.current_user_id() IS NOT NULL);
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS text AS $$ SELECT '' $$;`,
    );

    const findings = functionsDefinedBeforeUse(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "R6",
      where: "prisma/rls.sql:app.current_user_id",
    });
    expect(findings[0]?.message).toContain("used before it is defined");
    cleanup();
  });

  it("fires on a function that is called and never defined", () => {
    write("prisma/rls.sql", `CREATE POLICY p ON t USING (app.nope());`);

    expect(functionsDefinedBeforeUse(root)[0]?.message).toContain(
      "never defined",
    );
    cleanup();
  });

  it("does not read a function named in a comment as a call", () => {
    // This file explains itself at length, and several paragraphs name an
    // accessor above the statement that defines it.
    write(
      "prisma/rls.sql",
      `-- app.current_user_id() is defined below, with the tenant accessor.
CREATE FUNCTION app.current_user_id() RETURNS text AS $$ SELECT '' $$;`,
    );

    expect(functionsDefinedBeforeUse(root)).toEqual([]);
    cleanup();
  });

  it("does not report a definition as a use of itself", () => {
    write(
      "prisma/rls.sql",
      `CREATE OR REPLACE FUNCTION app.only() RETURNS text AS $$ SELECT '' $$;`,
    );

    expect(functionsDefinedBeforeUse(root)).toEqual([]);
    cleanup();
  });
});

describe("staticFindings", () => {
  it("is the union of the rules", () => {
    for (const entry of DIRECT_PRISMA_IMPORTERS) {
      write(entry.file, `import { prisma } from "@/lib/prisma";`);
    }
    for (const entry of UNSCOPED_READERS) {
      write(
        entry.file,
        `import { unscopedPrisma } from "@/lib/tenancy/client";`,
      );
    }
    write("src/lib/tenancy/scope.ts", GOOD_SCOPE);

    expect(staticFindings(root)).toEqual([]);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// The probes, against a database that answers however the test wants
// ---------------------------------------------------------------------------

/**
 * A fake Postgres that returns canned answers per statement.
 *
 * The probes are the half that cannot be exercised without a server, so what
 * this checks is the *reading*: that a bypassing role short-circuits, that a
 * probe seeing the wrong rows produces the finding it promises, and that the
 * fixture is always cleaned up. Whether Postgres actually behaves this way is
 * what CI's live run establishes.
 */
function fakeDb(answers: {
  bypass?: string[];
  scopedPosts?: string[];
  unscopedPosts?: string[];
  /** What a preview scoped to tenant A returns. The public site plus A's drafts. */
  previewPosts?: string[];
  /** What a preview whose setting is empty returns — T12's fail-closed probe. */
  previewWithoutTenantPosts?: string[];
  /** What a *scoped* connection returns when the preview setting is also set — T13. */
  previewWidensScope?: string[];
  scopedMemberships?: number;
  joinedTenants?: number;
  ownMembershipUsers?: string[];
  updateRowCount?: number;
  moveThrows?: boolean;
  unscopedInsertThrows?: boolean;
  leakedTenant?: string | null;
}) {
  const statements: string[] = [];
  let tenantScope: string | null = null;
  // Two variables and not one, because the preview capability now has three
  // states and the probes read all three: never opened, opened naming a
  // workspace, and opened naming none — which is what a missing or forged scope
  // cookie reaches the database as, and what T12 is about.
  let previewOpened = false;
  let previewTenant: string | null = null;

  const policyError = Object.assign(
    new Error("new row violates row-level security policy"),
    { code: "42501" },
  );

  const client: SqlClient = {
    async query(sql, values) {
      statements.push(sql);

      if (sql.includes("rls_bypass_reasons")) {
        return {
          rows: (answers.bypass ?? []).map((reason) => ({ reason })),
          rowCount: null,
        };
      }
      if (sql.includes("set_config") && sql.includes("app.tenant_id")) {
        tenantScope = (values?.[0] as string) || null;
        return { rows: [], rowCount: null };
      }
      if (sql.includes("set_config") && sql.includes("app.preview_tenant_id")) {
        previewOpened = true;
        previewTenant = (values?.[0] as string) || null;
        return { rows: [], rowCount: null };
      }
      if (sql.startsWith("BEGIN")) return { rows: [], rowCount: null };
      if (sql.startsWith("ROLLBACK")) {
        tenantScope = null;
        previewOpened = false;
        previewTenant = null;
        return { rows: [], rowCount: null };
      }
      if (sql.includes("current_setting('app.tenant_id'")) {
        return {
          rows: [{ value: answers.leakedTenant ?? "" }],
          rowCount: null,
        };
      }
      if (sql.startsWith("UPDATE posts SET title")) {
        return { rows: [], rowCount: answers.updateRowCount ?? 0 };
      }
      if (sql.includes('UPDATE posts SET "tenantId"')) {
        if (answers.moveThrows ?? true) throw policyError;
        return { rows: [], rowCount: 1 };
      }
      if (
        sql.includes("INSERT INTO posts") &&
        sql.includes("rls-probe-escape")
      ) {
        if (answers.unscopedInsertThrows ?? true) throw policyError;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM posts")) {
        // The scope is checked first because that is the order the policies
        // resolve in: `posts_preview_read` requires `app.current_tenant_id() IS
        // NULL`, so a scoped connection is unaffected by the capability however
        // it is set. `previewWidensScope` is how T13 asks what happens when that
        // conjunct is gone.
        const ids = tenantScope
          ? previewOpened && answers.previewWidensScope
            ? answers.previewWidensScope
            : (answers.scopedPosts ?? [FIXTURE.draftA, FIXTURE.publicA])
          : previewTenant
            ? (answers.previewPosts ?? [
                FIXTURE.draftA,
                FIXTURE.publicA,
                FIXTURE.publicB,
              ])
            : previewOpened
              ? (answers.previewWithoutTenantPosts ?? [
                  FIXTURE.publicA,
                  FIXTURE.publicB,
                ])
              : (answers.unscopedPosts ?? [FIXTURE.publicA, FIXTURE.publicB]);
        return { rows: ids.map((id) => ({ id })), rowCount: null };
      }
      if (sql.includes("JOIN tenants")) {
        return {
          rows: Array.from({ length: answers.joinedTenants ?? 1 }, (_, i) => ({
            slug: `s${i}`,
          })),
          rowCount: null,
        };
      }
      if (sql.includes("FROM memberships")) {
        if (tenantScope) {
          return {
            rows: Array.from(
              { length: answers.scopedMemberships ?? 1 },
              (_, i) => ({ id: `m${i}` }),
            ),
            rowCount: null,
          };
        }
        return {
          rows: (answers.ownMembershipUsers ?? [FIXTURE.userA]).map(
            (userId) => ({ userId }),
          ),
          rowCount: null,
        };
      }
      return { rows: [], rowCount: null };
    },
  };

  return { client, statements };
}

function admin() {
  const statements: string[] = [];
  return {
    statements,
    client: {
      async query(sql: string) {
        statements.push(sql);
        return { rows: [], rowCount: null };
      },
    } as SqlClient,
  };
}

describe("the probes", () => {
  it("pass against a database that isolates correctly", async () => {
    const app = fakeDb({});
    expect(await runtimeFindings(app.client, admin().client)).toEqual([]);
  });

  it("T1 — reports a bypassing role and stops there", async () => {
    // The finding that invalidates every other one. A superuser connection
    // would make the remaining probes report nonsense, so they do not run.
    const app = fakeDb({ bypass: ["role postgres is a superuser"] });

    const findings = await runtimeFindings(app.client, admin().client);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("T1");
    expect(app.statements.some((s) => s.includes("FROM posts"))).toBe(false);
  });

  it("T2 — fires when a scoped read sees another tenant's published rows", async () => {
    const app = fakeDb({
      scopedPosts: [FIXTURE.draftA, FIXTURE.publicA, FIXTURE.publicB],
    });

    const findings = await runtimeFindings(app.client, admin().client);

    expect(findings.map((f) => f.rule)).toContain("T2");
    expect(findings.find((f) => f.rule === "T2")?.message).toContain("IS NULL");
  });

  it("T3 — fires when a scoped UPDATE reaches another tenant's row", async () => {
    const app = fakeDb({ updateRowCount: 1 });

    expect(
      (await runtimeFindings(app.client, admin().client)).map((f) => f.rule),
    ).toContain("T3");
  });

  it("T4 — fires when a row can be moved into another tenant", async () => {
    const app = fakeDb({ moveThrows: false });

    expect(
      (await runtimeFindings(app.client, admin().client)).map((f) => f.rule),
    ).toContain("T4");
  });

  it("T5 — fires when an unscoped read sees a draft", async () => {
    const app = fakeDb({
      unscopedPosts: [FIXTURE.draftA, FIXTURE.publicA, FIXTURE.publicB],
    });

    const findings = await runtimeFindings(app.client, admin().client);

    expect(findings.find((f) => f.rule === "T5")?.message).toContain(
      "unpublished",
    );
  });

  it("T6 — fires when an unscoped connection can write", async () => {
    const app = fakeDb({ unscopedInsertThrows: false });

    expect(
      (await runtimeFindings(app.client, admin().client)).map((f) => f.rule),
    ).toContain("T6");
  });

  it("T7 — fires when a preview reads another workspace's drafts", async () => {
    // The gap this item closed, reproduced: a capability that is a boolean
    // returns every row, so a token minted inside tenant A opens tenant B's
    // unpublished posts too.
    const app = fakeDb({
      previewPosts: [
        FIXTURE.draftA,
        FIXTURE.publicA,
        FIXTURE.draftB,
        FIXTURE.publicB,
      ],
    });

    const findings = await runtimeFindings(app.client, admin().client);

    expect(findings.map((f) => f.rule)).toContain("T7");
    expect(findings.find((f) => f.rule === "T7")?.message).toContain(
      "another workspace's drafts",
    );
  });

  it("T7 — fires when a preview cannot see its own drafts", async () => {
    // The other direction, and the one a tightened predicate fails in: a
    // preview that shows exactly the public site is a preview that does nothing.
    const app = fakeDb({ previewPosts: [FIXTURE.publicA, FIXTURE.publicB] });

    const findings = await runtimeFindings(app.client, admin().client);

    expect(findings.map((f) => f.rule)).toContain("T7");
    expect(findings.find((f) => f.rule === "T7")?.message).toContain(
      "shows exactly what the public sees",
    );
  });

  it("T12 — fires when a preview naming no workspace reads drafts", async () => {
    // Fails closed or it fails open, and there is no third option: a scope
    // cookie that is missing, truncated or edited arrives as an empty setting,
    // and the one thing it must not mean is "every workspace".
    const app = fakeDb({
      previewWithoutTenantPosts: [
        FIXTURE.draftA,
        FIXTURE.publicA,
        FIXTURE.draftB,
        FIXTURE.publicB,
      ],
    });

    const findings = await runtimeFindings(app.client, admin().client);

    expect(findings.map((f) => f.rule)).toContain("T12");
    expect(findings.find((f) => f.rule === "T12")?.message).toContain(
      "like an " + "anonymous visitor",
    );
  });

  it("T13 — fires when the preview capability widens a tenant scope", async () => {
    // `posts_preview_read` without its `app.current_tenant_id() IS NULL`
    // conjunct: the dashboard's own scoped connection is then one `set_config`
    // from another workspace, using a setting the application writes next door.
    const app = fakeDb({
      previewWidensScope: [
        FIXTURE.draftA,
        FIXTURE.publicA,
        FIXTURE.draftB,
        FIXTURE.publicB,
      ],
    });

    const findings = await runtimeFindings(app.client, admin().client);

    expect(findings.map((f) => f.rule)).toContain("T13");
    expect(findings.find((f) => f.rule === "T13")?.message).toContain(
      "IS NULL",
    );
  });

  it("T8 — fires when the scope outlives its transaction", async () => {
    // The property the whole design rests on, and the one that is invisible
    // until a pool reuses a connection.
    const app = fakeDb({ leakedTenant: FIXTURE.tenantA });

    const findings = await runtimeFindings(app.client, admin().client);

    expect(findings.map((f) => f.rule)).toContain("T8");
    expect(findings.find((f) => f.rule === "T8")?.message).toContain("TRUE");
  });

  it("T9 — fires when a member can enumerate another tenant's memberships", async () => {
    const app = fakeDb({ scopedMemberships: 2 });

    expect(
      (await runtimeFindings(app.client, admin().client)).map((f) => f.rule),
    ).toContain("T9");
  });

  it("T10 — fires when the pre-scope read returns other users' memberships", async () => {
    const app = fakeDb({ ownMembershipUsers: [FIXTURE.userA, FIXTURE.userB] });

    expect(
      (await runtimeFindings(app.client, admin().client)).map((f) => f.rule),
    ).toContain("T10");
  });

  it("T11 — fires when the pre-scope read cannot resolve its tenants", async () => {
    // The bug a running build found: a `tenants` policy keyed only on the
    // tenant id hides every row from the read that decides the tenant, and the
    // join yields NULL rather than failing.
    const app = fakeDb({ joinedTenants: 0 });

    const findings = await runtimeFindings(app.client, admin().client);

    expect(findings.map((f) => f.rule)).toContain("T11");
    expect(findings.find((f) => f.rule === "T11")?.message).toContain(
      "before " + "any tenant scope exists",
    );
  });

  it("removes its fixture even when a probe fails", async () => {
    // A gate that leaves rows behind is a gate that passes once, and then
    // fails on a unique constraint for reasons that look like a policy bug.
    const app = fakeDb({ updateRowCount: 1 });
    const db = admin();

    await runtimeFindings(app.client, db.client);

    const deletes = db.statements.filter((s) => s.startsWith("DELETE"));
    expect(deletes.length).toBeGreaterThanOrEqual(2);
  });

  it("rolls back every transaction it opens", async () => {
    const app = fakeDb({});

    await runtimeFindings(app.client, admin().client);

    const begins = app.statements.filter((s) => s.startsWith("BEGIN")).length;
    const rollbacks = app.statements.filter((s) =>
      s.startsWith("ROLLBACK"),
    ).length;
    expect(begins).toBe(rollbacks);
    expect(begins).toBeGreaterThan(0);
  });
});
