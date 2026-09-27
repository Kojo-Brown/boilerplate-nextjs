import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DIRECT_PRISMA_IMPORTERS,
  FIXTURE,
  UNSCOPED_READERS,
  directPrismaImports,
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
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts FORCE ROW LEVEL SECURITY;
CREATE POLICY posts_tenant_scope ON public.posts
  USING ("tenantId" = app.current_tenant_id());
SELECT current_setting('app.tenant_id', true);
SELECT current_setting('app.user_id', true);
`;

const GOOD_SCOPE = `
export const TENANT_GUC = "app.tenant_id";
export const USER_GUC = "app.user_id";
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
  it("passes when the policy file reads both settings", () => {
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
      `export const TENANT_GUC = prefix + "tenant_id";\nexport const USER_GUC = "app.user_id";`,
    );

    expect(gucNamesAgree(root)[0]?.message).toContain("string literal");
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

  it("counts a preview read as an unscoped one", () => {
    // It is more than unscoped: it can see other tenants' *drafts*.
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
  previewCount?: number;
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
  let preview = false;

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
      if (sql.includes("set_config") && sql.includes("app.preview")) {
        preview = true;
        return { rows: [], rowCount: null };
      }
      if (sql.startsWith("BEGIN")) return { rows: [], rowCount: null };
      if (sql.startsWith("ROLLBACK")) {
        tenantScope = null;
        preview = false;
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
        if (preview) {
          return {
            rows: Array.from({ length: answers.previewCount ?? 4 }, (_, i) => ({
              id: `p${i}`,
            })),
            rowCount: null,
          };
        }
        const ids = tenantScope
          ? (answers.scopedPosts ?? [FIXTURE.draftA, FIXTURE.publicA])
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

  it("T7 — fires when draft mode cannot see drafts", async () => {
    const app = fakeDb({ previewCount: 2 });

    expect(
      (await runtimeFindings(app.client, admin().client)).map((f) => f.rule),
    ).toContain("T7");
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
