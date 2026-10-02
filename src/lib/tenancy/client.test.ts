import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * What a unit test can say about the scoped client, and what it cannot.
 *
 * It can say that the scope is opened, that both settings are written, that
 * the values travel as bind parameters rather than being pasted into the SQL,
 * and — the load-bearing one — that the third argument to `set_config` is
 * `TRUE`, which is what makes the setting transaction-local and therefore safe
 * on a pooled connection.
 *
 * It cannot say that any of that *works*: whether the statements land on the
 * same backend connection as the query, whether a rolled-back transaction
 * leaves the setting behind, and whether the policies then hide anything are
 * all properties of Postgres. `scripts/assert-tenant-isolation.ts` measures
 * those against a real database, with two tenants, which is the only
 * configuration in which the answer can be wrong.
 */
const { prisma, statements } = vi.hoisted(() => {
  const statements: { sql: string; values: unknown[] }[] = [];

  const executeRaw = (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ sql: strings.join("?"), values });
    return Promise.resolve(1);
  };

  return {
    statements,
    prisma: {
      $executeRaw: vi.fn(executeRaw),
      $extends: vi.fn(),
      $transaction: vi.fn(),
      post: { findMany: vi.fn() },
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma }));

import {
  withPreviewRead,
  withTenantTransaction,
  withUserTransaction,
} from "./client";
import {
  InvalidTenantScopeError,
  PREVIEW_GUC,
  TENANT_GUC,
  USER_GUC,
} from "./scope";

/** A transaction client that records the statements run on it. */
function transactionClient() {
  return {
    $executeRaw: vi.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        statements.push({ sql: strings.join("?"), values });
        return Promise.resolve(1);
      },
    ),
    post: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  statements.length = 0;

  prisma.$transaction.mockImplementation(
    async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(transactionClient()),
  );
});

describe("withTenantTransaction", () => {
  const scope = { tenantId: "tenant-1", userId: "user-1" };

  it("opens both settings before the callback runs", async () => {
    let seenAtCallbackTime = 0;

    await withTenantTransaction(scope, async () => {
      seenAtCallbackTime = statements.length;
      return null;
    });

    // Two statements, already issued. A scope opened *after* the first query
    // is a query that ran unscoped, which under these policies returns
    // published rows and nothing else — an empty dashboard, not an error.
    expect(seenAtCallbackTime).toBe(2);
    expect(statements[0]?.sql).toContain("set_config");
    expect(statements[1]?.sql).toContain("set_config");
  });

  it("writes the tenant and the user, in that order", async () => {
    await withTenantTransaction(scope, async () => null);

    expect(statements[0]?.values).toEqual([TENANT_GUC, "tenant-1"]);
    expect(statements[1]?.values).toEqual([USER_GUC, "user-1"]);
  });

  it("makes the setting transaction-local", async () => {
    // The whole safety property. `set_config(…, FALSE)` outlives the
    // transaction, and the next request to be handed that pooled connection
    // inherits it — which is either another tenant or the public blog.
    //
    // `TRUE` is asserted in the SQL *text* rather than among the bind
    // parameters, and that is the point: it is a literal in the template, so
    // no caller can pass `false` for it. The two values that are
    // caller-supplied are parameters; the flag that makes them safe is not.
    await withTenantTransaction(scope, async () => null);

    for (const statement of statements) {
      expect(statement.sql).toMatch(/,\s*TRUE\s*\)/);
    }
  });

  it("passes the values as bind parameters, not as SQL text", async () => {
    await withTenantTransaction(scope, async () => null);

    // The tagged template splits on every interpolation, so a value that
    // reached the SQL text would show up here instead of in `values`.
    expect(statements[0]?.sql).not.toContain("tenant-1");
    expect(statements[0]?.values).toContain("tenant-1");
  });

  it("returns whatever the callback returned", async () => {
    await expect(
      withTenantTransaction(scope, async () => "result"),
    ).resolves.toBe("result");
  });

  it("propagates a throw, so the transaction rolls back", async () => {
    await expect(
      withTenantTransaction(scope, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("hands the callback the transaction client, not a scoped one", async () => {
    // A scoped client inside a transaction would try to open a transaction of
    // its own for every statement, and Postgres has no nested one to give it.
    let received: unknown;
    await withTenantTransaction(scope, async (tx) => {
      received = tx;
      return null;
    });

    expect(received).not.toBe(prisma);
    expect(received).toHaveProperty("$executeRaw");
  });

  it("forwards the timeout options to the transaction", async () => {
    await withTenantTransaction(scope, async () => null, {
      timeout: 1234,
      maxWait: 567,
    });

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 1234,
      maxWait: 567,
    });
  });
});

describe("withUserTransaction", () => {
  it("clears the tenant and sets only the user", async () => {
    // The read that decides which tenant may be opened cannot itself be made
    // inside one. Writing the tenant as `''` rather than leaving it alone is
    // what makes the absence local and deliberate.
    await withUserTransaction("user-1", async () => null);

    expect(statements).toHaveLength(2);
    expect(statements[0]?.values).toEqual([TENANT_GUC, ""]);
    expect(statements[1]?.values).toEqual([USER_GUC, "user-1"]);
    expect(statements[0]?.sql).toMatch(/,\s*TRUE\s*\)/);
  });

  it("refuses an id that is not one, before opening a transaction", async () => {
    await expect(withUserTransaction("", async () => null)).rejects.toThrow(
      InvalidTenantScopeError,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("withPreviewRead", () => {
  const TENANT = "tenant-mock-a";

  it("names the workspace it may read, and opens no tenant scope", async () => {
    // One statement, not two. The capability *is* the workspace — there is no
    // `app.tenant_id` here, because `posts_preview_read` requires
    // `app.current_tenant_id() IS NULL` so that a bearer capability can never
    // widen a scoped read, and no second setting to forget to write.
    await withPreviewRead(TENANT, async () => null);

    expect(statements).toHaveLength(1);
    expect(statements[0]?.values).toEqual([PREVIEW_GUC, TENANT]);
  });

  it("is transaction-local like the others", async () => {
    await withPreviewRead(TENANT, async () => null);

    expect(statements[0]?.sql).toMatch(/,\s*TRUE\s*\)/);
  });

  it("returns the callback's value", async () => {
    await expect(
      withPreviewRead(TENANT, async () => ["post"]),
    ).resolves.toEqual(["post"]);
  });

  it("refuses a workspace it could not scope to, before opening a transaction", async () => {
    // The empty string is the one that matters, and it does not throw in
    // Postgres: `set_config` accepts it, `app.preview_tenant_id()` maps it back
    // to NULL, and the preview silently reads the published site. There is no
    // unscoped preview to fall back to, so this is refused here instead.
    await expect(withPreviewRead("", async () => null)).rejects.toThrow(
      InvalidTenantScopeError,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
