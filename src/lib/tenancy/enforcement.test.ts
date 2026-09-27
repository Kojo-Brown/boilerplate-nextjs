import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: vi.fn() } }));

import {
  RlsNotInstalledError,
  assertRlsEnforced,
  readRlsEnforcement,
} from "./enforcement";

/** A client whose one query answers with the given rows, or throws. */
function client(result: { reason: string }[] | Error) {
  return {
    $queryRaw: vi.fn(() =>
      result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result),
    ),
  } as unknown as Parameters<typeof readRlsEnforcement>[0];
}

/** The shapes Prisma reports `undefined_function` in, which differ by path. */
function undefinedFunction(shape: "code" | "meta" | "message") {
  if (shape === "code")
    return Object.assign(new Error("boom"), { code: "42883" });
  if (shape === "meta")
    return Object.assign(new Error("boom"), { meta: { code: "42883" } });
  return new Error(
    "Database error. Code: `42883`. Message: `function app.rls_bypass_reasons() does not exist`",
  );
}

describe("readRlsEnforcement", () => {
  it("reports enforced when the database returns no reasons", async () => {
    const result = await readRlsEnforcement(client([]));

    expect(result).toEqual({ enforced: true, reasons: [] });
  });

  it("reports every reason rather than the first", async () => {
    // The CI gate prints all of them. A connection that is both a superuser
    // and the table owner has two problems, and fixing one leaves the other.
    const result = await readRlsEnforcement(
      client([
        { reason: "role postgres is a superuser" },
        { reason: "role postgres has BYPASSRLS" },
      ]),
    );

    expect(result.enforced).toBe(false);
    expect(result.reasons).toHaveLength(2);
  });

  it.each(["code", "meta", "message"] as const)(
    "recognises undefined_function reported via %s",
    async (shape) => {
      // "Not installed" and "installed but bypassed" have different fixes, and
      // the first is what a fresh checkout hits — `pnpm db:rls` has not run.
      await expect(
        readRlsEnforcement(client(undefinedFunction(shape))),
      ).rejects.toThrow(RlsNotInstalledError);
    },
  );

  it("points at the command that fixes it", async () => {
    await expect(
      readRlsEnforcement(client(undefinedFunction("code"))),
    ).rejects.toThrow(/pnpm db:rls/);
  });

  it("does not read an unrelated 42883 as this function being missing", async () => {
    // The message branch is last and requires the function's own name, so a
    // `42883` from somewhere else stays the error it was.
    const unrelated = new Error(
      "Database error. Code: `42883`. Message: `no such function lower(int)`",
    );

    await expect(readRlsEnforcement(client(unrelated))).rejects.toThrow(
      /no such function/,
    );
  });

  it("rethrows anything else untouched", async () => {
    await expect(
      readRlsEnforcement(client(new Error("connection refused"))),
    ).rejects.toThrow("connection refused");
  });
});

describe("assertRlsEnforced", () => {
  it("returns quietly when enforcement is in effect", async () => {
    await expect(assertRlsEnforced(client([]))).resolves.toBeUndefined();
  });

  it("throws with every reason listed", async () => {
    const thrown = await assertRlsEnforced(
      client([{ reason: "role postgres is a superuser" }]),
    ).then(
      () => new Error("assertRlsEnforced resolved but should have thrown"),
      (error: unknown) => error as Error,
    );

    expect(thrown.message).toContain("not enforced");
    expect(thrown.message).toContain("role postgres is a superuser");
  });

  it("says what to do about it", async () => {
    // The failure is invisible from inside the application, so the message has
    // to carry the fix: the role, not the policies, is what is wrong.
    const thrown = await assertRlsEnforced(
      client([{ reason: "role postgres has BYPASSRLS" }]),
    ).then(
      () => new Error("assertRlsEnforced resolved but should have thrown"),
      (error: unknown) => error as Error,
    );

    expect(thrown.message).toContain("DATABASE_URL");
    expect(thrown.message).toContain("app_rls");
  });
});
