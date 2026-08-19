import { describe, it, expect } from "vitest";
import {
  builtRouteHandlers,
  builtRuntime,
  checkApiRuntimes,
  foreignPackages,
  packageOf,
} from "./assert-api-runtimes";
import type { ApiRouteDeclaration } from "../src/lib/api/runtimes";

const APP_PATHS = {
  "/api/health/route": "/api/health",
  "/api/posts/route": "/api/posts",
  "/page": "/",
  "/blog/[slug]/page": "/blog/[slug]",
};

const NO_EDGE_FUNCTIONS = { functions: {} };

const declaration = (
  overrides: Partial<ApiRouteDeclaration> = {},
): ApiRouteDeclaration => ({
  path: "/api/health",
  runtime: "nodejs",
  portable: true,
  because: "a liveness probe reads nothing",
  ...overrides,
});

/** A trace of framework files only — what a portable route should look like. */
const portableTrace = {
  files: [
    "../../../../node_modules/.pnpm/next@16.2.9/node_modules/next/dist/server/route-modules/app-route/module.js",
    "../../../../node_modules/.pnpm/react@19.2.7/node_modules/react/index.js",
    "../../../../node_modules/.pnpm/@swc+helpers@0.5.15/node_modules/@swc/helpers/esm/index.js",
    "../../route.js",
  ],
};

describe("packageOf", () => {
  it("reads the package out of a pnpm virtual-store path", () => {
    expect(
      packageOf(
        "../../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/client.js",
      ),
    ).toBe("pg");
  });

  it("keeps the scope on a scoped package", () => {
    expect(
      packageOf(
        "../node_modules/.pnpm/@prisma+client@7.9.1/node_modules/@prisma/client/index.js",
      ),
    ).toBe("@prisma/client");
  });

  it("reads a flat (non-pnpm) layout too", () => {
    expect(packageOf("node_modules/next/dist/server/index.js")).toBe("next");
  });

  it("returns null for a first-party file", () => {
    expect(packageOf("../../src/lib/photos.ts")).toBeNull();
  });
});

describe("foreignPackages", () => {
  it("finds nothing in a framework-only trace", () => {
    expect(foreignPackages(portableTrace)).toEqual([]);
  });

  it("reports application dependencies, deduplicated and sorted", () => {
    const trace = {
      files: [
        ...portableTrace.files,
        "../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/client.js",
        "../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/pool.js",
        "../node_modules/.pnpm/@prisma+client@7.9.1/node_modules/@prisma/client/index.js",
      ],
    };
    expect(foreignPackages(trace)).toEqual(["@prisma/client", "pg"]);
  });

  it("does not report `.pnpm` itself, which is store bookkeeping and not a package", () => {
    expect(
      foreignPackages({ files: ["../node_modules/.pnpm/lock.yaml"] }),
    ).toEqual([]);
  });
});

describe("builtRuntime", () => {
  it("reads nodejs when the route is absent from the edge bundle", () => {
    expect(builtRuntime(NO_EDGE_FUNCTIONS, "/api/health")).toBe("nodejs");
  });

  it("reads edge when the route was compiled into the edge bundle", () => {
    expect(
      builtRuntime({ functions: { "/api/health/route": {} } }, "/api/health"),
    ).toBe("edge");
  });

  it("tolerates a manifest with no functions key at all", () => {
    expect(builtRuntime({}, "/api/health")).toBe("nodejs");
  });
});

describe("builtRouteHandlers", () => {
  it("lists route handlers and ignores pages", () => {
    expect(builtRouteHandlers(APP_PATHS)).toEqual([
      "/api/health",
      "/api/posts",
    ]);
  });
});

describe("checkApiRuntimes", () => {
  const readTrace = () => portableTrace;

  it("passes when the build matches the declarations", () => {
    const violations = checkApiRuntimes(
      APP_PATHS,
      NO_EDGE_FUNCTIONS,
      readTrace,
      [
        declaration(),
        declaration({
          path: "/api/posts",
          portable: false,
          because: "reads Prisma",
        }),
      ],
    );
    expect(violations).toEqual([]);
  });

  it("fails on a route handler that no declaration covers", () => {
    const violations = checkApiRuntimes(
      APP_PATHS,
      NO_EDGE_FUNCTIONS,
      readTrace,
      [declaration()],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.route).toBe("/api/posts");
    expect(violations[0]?.problem).toContain("not declared");
  });

  it("fails on a declared route that was not built", () => {
    const violations = checkApiRuntimes({}, NO_EDGE_FUNCTIONS, readTrace, [
      declaration(),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("no route handler was built");
  });

  it("fails when a route built on a runtime it did not declare", () => {
    const violations = checkApiRuntimes(
      { "/api/health/route": "/api/health" },
      { functions: { "/api/health/route": {} } },
      readTrace,
      [declaration()],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toBe(
      "declares the nodejs runtime but built on edge.",
    );
  });

  it("fails when a portable route acquires a Node-only dependency", () => {
    // The regression this gate exists for: adding one Prisma import to
    // `/api/photos` changes no source line that says "runtime" and builds green.
    const withPrisma = () => ({
      files: [
        ...portableTrace.files,
        "../node_modules/.pnpm/@prisma+client@7.9.1/node_modules/@prisma/client/index.js",
      ],
    });

    const violations = checkApiRuntimes(
      { "/api/health/route": "/api/health" },
      NO_EDGE_FUNCTIONS,
      withPrisma,
      [declaration()],
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("@prisma/client");
  });

  it("does not check portability for a route that never claimed it", () => {
    const violations = checkApiRuntimes(
      { "/api/posts/route": "/api/posts" },
      NO_EDGE_FUNCTIONS,
      () => ({
        files: [
          "../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/client.js",
        ],
      }),
      [
        declaration({
          path: "/api/posts",
          portable: false,
          because: "reads Prisma",
        }),
      ],
    );
    expect(violations).toEqual([]);
  });

  it("fails when a portable route has no trace to check", () => {
    const violations = checkApiRuntimes(
      { "/api/health/route": "/api/health" },
      NO_EDGE_FUNCTIONS,
      () => null,
      [declaration()],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("cannot be checked");
  });
});
