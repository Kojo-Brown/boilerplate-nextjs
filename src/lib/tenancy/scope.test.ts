import { describe, it, expect } from "vitest";

import {
  InvalidTenantScopeError,
  TENANT_GUC,
  USER_GUC,
  assertScopeId,
  tenantScope,
} from "./scope";

describe("tenantScope", () => {
  it("returns both halves", () => {
    expect(tenantScope("tenant-1", "user-1")).toEqual({
      tenantId: "tenant-1",
      userId: "user-1",
    });
  });

  it("accepts a cuid, which is what both ids actually are", () => {
    expect(() =>
      tenantScope("cmukb1lpd00009s7de2g9kjdw", "cmukb24n10000bl7d51riu2ku"),
    ).not.toThrow();
  });

  it("refuses an empty tenant id", () => {
    // The one that matters. `set_config('app.tenant_id', '', true)` succeeds,
    // and `app.current_tenant_id()` maps `''` back to NULL — so an empty id
    // does not fail, it silently opens the unscoped view. A dashboard built on
    // that shows an empty workspace and no error anywhere.
    expect(() => tenantScope("", "user-1")).toThrow(InvalidTenantScopeError);
    expect(() => tenantScope("", "user-1")).toThrow(/non-empty tenantId/);
  });

  it("refuses an empty user id", () => {
    expect(() => tenantScope("tenant-1", "")).toThrow(InvalidTenantScopeError);
    expect(() => tenantScope("tenant-1", "")).toThrow(/non-empty userId/);
  });

  it("names the field it rejected", () => {
    // A scope has two ids of the same shape. An error that does not say which
    // one was wrong sends the reader to the wrong call site.
    expect(() => tenantScope("bad id", "user-1")).toThrow(/tenantId/);
    expect(() => tenantScope("tenant-1", "bad id")).toThrow(/userId/);
  });

  it.each([
    ["a space", "tenant 1"],
    ["a newline", "tenant\n1"],
    ["a null byte", "tenant\u00001"],
    ["a quote", "tenant'1"],
    ["a semicolon", "tenant;1"],
  ])("refuses %s", (_name, value) => {
    // Not because of injection — the value is a bind parameter — but because
    // a scope whose id cannot equal any column value is an isolation failure
    // that presents as an empty page rather than as an error.
    expect(() => tenantScope(value, "user-1")).toThrow(InvalidTenantScopeError);
  });

  it("refuses an absurdly long id", () => {
    expect(() => tenantScope("a".repeat(129), "user-1")).toThrow(
      /at most 128 characters/,
    );
    expect(() => tenantScope("a".repeat(128), "user-1")).not.toThrow();
  });
});

describe("assertScopeId", () => {
  it("checks one id, for the read that has a user and deliberately no tenant", () => {
    expect(() => assertScopeId("user-1", "userId")).not.toThrow();
    expect(() => assertScopeId("", "userId")).toThrow(InvalidTenantScopeError);
  });
});

describe("the setting names", () => {
  it("are namespaced, because Postgres refuses a custom GUC without a dot", () => {
    // `set_config('tenant_id', …)` fails with `invalid configuration parameter
    // name`. This is the sort of thing that is obvious once and never again.
    expect(TENANT_GUC).toContain(".");
    expect(USER_GUC).toContain(".");
  });

  it("are distinct, so one cannot be written over the other", () => {
    expect(TENANT_GUC).not.toBe(USER_GUC);
  });
});
