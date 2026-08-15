import { describe, expect, it } from "vitest";
import {
  EXPECTED_ROUTES,
  checkRouteShape,
  formatViolations,
  readPrerenderManifest,
  type PrerenderManifest,
} from "./assert-route-shape";

/**
 * A manifest shaped like the one the current build produces. Tests mutate a
 * copy of this to describe a regression, so each case says exactly which part
 * of a real build it is corrupting.
 */
function goodManifest(): PrerenderManifest {
  return {
    routes: {
      "/": { initialRevalidateSeconds: false },
      "/_not-found": { initialRevalidateSeconds: false },
      "/forbidden": { initialRevalidateSeconds: false },
      "/login": { initialRevalidateSeconds: false },
      "/register": { initialRevalidateSeconds: false },
      "/blog": { initialRevalidateSeconds: 60, srcRoute: "/blog" },
      "/blog/seed-post-cache-life": {
        initialRevalidateSeconds: 300,
        srcRoute: "/blog/[slug]",
      },
      "/blog/seed-post-partial-prerendering": {
        initialRevalidateSeconds: 300,
        srcRoute: "/blog/[slug]",
      },
    },
    dynamicRoutes: { "/blog/[slug]": {} },
  };
}

describe("checkRouteShape", () => {
  it("passes a manifest matching the expected route shape", () => {
    expect(checkRouteShape(goodManifest())).toEqual([]);
  });

  it("catches the regression it exists for: a static route gone dynamic", () => {
    // This is what awaiting auth() in the root layout did to every route —
    // the page simply stops appearing in the prerender manifest.
    const manifest = goodManifest();
    delete manifest.routes["/"];

    const violations = checkRouteShape(manifest);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.route).toBe("/");
    expect(violations[0]?.problem).toContain(
      "missing from the prerender manifest",
    );
  });

  it("reports every regressed route, not just the first", () => {
    const manifest = goodManifest();
    delete manifest.routes["/login"];
    delete manifest.routes["/register"];

    expect(checkRouteShape(manifest).map((v) => v.route)).toEqual([
      "/login",
      "/register",
    ]);
  });

  it("catches a `revalidate` export that never took effect", () => {
    // /blog present but with no window is precisely the state the repository
    // was in: statically listed, yet re-rendered on every request.
    const manifest = goodManifest();
    manifest.routes["/blog"] = {
      initialRevalidateSeconds: false,
      srcRoute: "/blog",
    };

    const violations = checkRouteShape(manifest);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain(
      "expected a 60s revalidation window",
    );
    expect(violations[0]?.problem).toContain("revalidation disabled");
  });

  it("distinguishes a missing window from a wrong one", () => {
    const manifest = goodManifest();
    manifest.routes["/blog"] = { srcRoute: "/blog" };

    expect(checkRouteShape(manifest)[0]?.problem).toContain("no window at all");

    const wrong = goodManifest();
    wrong.routes["/blog"] = { initialRevalidateSeconds: 30, srcRoute: "/blog" };

    expect(checkRouteShape(wrong)[0]?.problem).toContain("built with 30s");
  });

  it("catches generateStaticParams returning an empty array", () => {
    // The unseeded-CI-database failure: the segment still exists, but nothing
    // was enumerated from it.
    const manifest = goodManifest();
    delete manifest.routes["/blog/seed-post-cache-life"];
    delete manifest.routes["/blog/seed-post-partial-prerendering"];

    const violations = checkRouteShape(manifest);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.route).toBe("/blog/[slug]");
    expect(violations[0]?.problem).toContain("pnpm db:seed");
  });

  it("catches a dynamic segment that stopped prerendering altogether", () => {
    const manifest = goodManifest();
    manifest.dynamicRoutes = {};

    expect(checkRouteShape(manifest)[0]?.problem).toContain(
      "not in dynamicRoutes",
    );
  });

  it("checks the window on every prebuilt page, not only the first", () => {
    const manifest = goodManifest();
    manifest.routes["/blog/seed-post-partial-prerendering"] = {
      initialRevalidateSeconds: 60,
      srcRoute: "/blog/[slug]",
    };

    const violations = checkRouteShape(manifest);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.route).toBe("/blog/seed-post-partial-prerendering");
  });

  it("ignores routes it was given no expectation for", () => {
    // /dashboard and friends are supposed to be dynamic. Their absence from
    // the manifest must not be an error.
    const manifest = goodManifest();

    expect(checkRouteShape(manifest, [])).toEqual([]);
  });
});

describe("EXPECTED_ROUTES", () => {
  it("gives every expectation a reason, so a failure explains itself", () => {
    for (const expectation of EXPECTED_ROUTES) {
      expect(expectation.because.length).toBeGreaterThan(0);
    }
  });

  it("lists no route twice", () => {
    const routes = EXPECTED_ROUTES.map((e) => e.route);
    expect(new Set(routes).size).toBe(routes.length);
  });
});

describe("formatViolations", () => {
  it("names the route, the problem, and why it was expected", () => {
    const manifest = goodManifest();
    delete manifest.routes["/blog"];

    const output = formatViolations(checkRouteShape(manifest));

    expect(output).toContain("/blog");
    expect(output).toContain("expected because:");
    expect(output).toContain("Phase 5 ISR item");
  });
});

describe("readPrerenderManifest", () => {
  it("explains that a build has to run first when the manifest is absent", () => {
    expect(() => readPrerenderManifest("does-not-exist")).toThrow(
      /Run `pnpm build`/,
    );
  });
});
