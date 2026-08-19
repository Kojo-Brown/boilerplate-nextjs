import { describe, it, expect, afterEach } from "vitest";
import { API_ROUTES, detectRuntime, findApiRoute } from "./runtimes";

const globals = globalThis as { EdgeRuntime?: unknown };

afterEach(() => {
  delete globals.EdgeRuntime;
});

describe("detectRuntime", () => {
  it("reports nodejs when the edge marker is absent", () => {
    expect(detectRuntime()).toBe("nodejs");
  });

  it("reports edge when the runtime defines its marker", () => {
    globals.EdgeRuntime = "edge-runtime";
    expect(detectRuntime()).toBe("edge");
  });

  it("ignores a non-string marker", () => {
    globals.EdgeRuntime = true;
    expect(detectRuntime()).toBe("nodejs");
  });
});

describe("findApiRoute", () => {
  it("finds a declared route", () => {
    expect(findApiRoute("/api/health")?.portable).toBe(true);
  });

  it("returns undefined for an unknown path", () => {
    expect(findApiRoute("/api/nope")).toBeUndefined();
  });
});

describe("API_ROUTES", () => {
  it("declares each path exactly once", () => {
    const paths = API_ROUTES.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("gives every route a reason, since the reason is what a failure prints", () => {
    for (const route of API_ROUTES) {
      expect(route.because.length).toBeGreaterThan(0);
    }
  });

  it("declares only routes under /api/", () => {
    for (const route of API_ROUTES) {
      expect(route.path.startsWith("/api/")).toBe(true);
    }
  });

  it("records that no route runs on the edge today", () => {
    // Not a preference — Cache Components rejects the `runtime` segment config
    // outright, so `edge` is currently unreachable. If this ever fails, the
    // constraint has lifted and `docs/route-handlers.md` needs revisiting
    // rather than this assertion being deleted.
    expect(API_ROUTES.every((route) => route.runtime === "nodejs")).toBe(true);
  });
});
