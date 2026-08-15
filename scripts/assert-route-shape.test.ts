import { describe, expect, it } from "vitest";
import {
  EXPECTED_ROUTES,
  checkRouteShape,
  createShellReader,
  formatViolations,
  readPrerenderManifest,
  type PrerenderManifest,
  type RouteExpectation,
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
      "/dashboard": { initialRevalidateSeconds: false, srcRoute: "/dashboard" },
      "/posts": { initialRevalidateSeconds: false, srcRoute: "/posts" },
      "/admin": { initialRevalidateSeconds: false, srcRoute: "/admin" },
      "/images": { initialRevalidateSeconds: false, srcRoute: "/images" },
      "/upload": { initialRevalidateSeconds: false, srcRoute: "/upload" },
    },
    dynamicRoutes: { "/blog/[slug]": {} },
  };
}

/** A shell carrying the dashboard chrome — what a healthy build writes. */
const CHROME =
  "<html><body><nav>Dashboard Posts Upload Image Showcase</nav><main></main></body></html>";

/**
 * `checkRouteShape` with the healthy defaults filled in, so each test only has
 * to describe the one thing it is breaking.
 */
function check(
  manifest: PrerenderManifest,
  expectations: readonly RouteExpectation[] = EXPECTED_ROUTES,
  readShell: (route: string) => string | null = () => CHROME,
) {
  return checkRouteShape(manifest, expectations, readShell);
}

describe("checkRouteShape", () => {
  it("passes a manifest matching the expected route shape", () => {
    expect(check(goodManifest())).toEqual([]);
  });

  it("catches the regression it exists for: a static route gone dynamic", () => {
    // This is what awaiting auth() in the root layout did to every route —
    // the page simply stops appearing in the prerender manifest.
    const manifest = goodManifest();
    delete manifest.routes["/"];

    const violations = check(manifest);

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

    expect(check(manifest).map((v) => v.route)).toEqual([
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

    const violations = check(manifest);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain(
      "expected a 60s revalidation window",
    );
    expect(violations[0]?.problem).toContain("revalidation disabled");
  });

  it("distinguishes a missing window from a wrong one", () => {
    const manifest = goodManifest();
    manifest.routes["/blog"] = { srcRoute: "/blog" };

    expect(check(manifest)[0]?.problem).toContain("no window at all");

    const wrong = goodManifest();
    wrong.routes["/blog"] = { initialRevalidateSeconds: 30, srcRoute: "/blog" };

    expect(check(wrong)[0]?.problem).toContain("built with 30s");
  });

  it("catches generateStaticParams returning an empty array", () => {
    // The unseeded-CI-database failure: the segment still exists, but nothing
    // was enumerated from it.
    const manifest = goodManifest();
    delete manifest.routes["/blog/seed-post-cache-life"];
    delete manifest.routes["/blog/seed-post-partial-prerendering"];

    const violations = check(manifest);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.route).toBe("/blog/[slug]");
    expect(violations[0]?.problem).toContain("pnpm db:seed");
  });

  it("catches a dynamic segment that stopped prerendering altogether", () => {
    const manifest = goodManifest();
    manifest.dynamicRoutes = {};

    expect(check(manifest)[0]?.problem).toContain("not in dynamicRoutes");
  });

  it("checks the window on every prebuilt page, not only the first", () => {
    const manifest = goodManifest();
    manifest.routes["/blog/seed-post-partial-prerendering"] = {
      initialRevalidateSeconds: 60,
      srcRoute: "/blog/[slug]",
    };

    const violations = check(manifest);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.route).toBe("/blog/seed-post-partial-prerendering");
  });

  it("ignores routes it was given no expectation for", () => {
    // /dashboard and friends are supposed to be dynamic. Their absence from
    // the manifest must not be an error.
    const manifest = goodManifest();

    expect(check(manifest, [])).toEqual([]);
  });
});

describe("checkRouteShape — Partial Prerendering shells", () => {
  const SHELL: readonly RouteExpectation[] = [
    {
      route: "/posts",
      kind: "shell",
      shellMustContain: ["Dashboard", "Posts"],
      because: "the posts shell must prerender its navigation",
    },
  ];

  function manifestWithPosts(): PrerenderManifest {
    const manifest = goodManifest();
    manifest.routes["/posts"] = {
      initialRevalidateSeconds: false,
      srcRoute: "/posts",
    };
    return manifest;
  }

  it("passes when the shell contains the chrome", () => {
    const violations = checkRouteShape(
      manifestWithPosts(),
      SHELL,
      () => "<html><body><nav>Dashboard Posts</nav></body></html>",
    );

    expect(violations).toEqual([]);
  });

  it("catches the empty shell — the regression PPR is most likely to hide", () => {
    // What `/posts` actually built when `(dashboard)/layout.tsx` awaited the
    // session: 2.6 KB containing a <title> and nothing else. The manifest
    // still called it partially static, which is why the check reads the HTML.
    //
    // Note the `<title>` satisfies the "Posts" marker on its own. That is why
    // EXPECTED_ROUTES asks every dashboard route for all three sidebar links
    // rather than its own name: a route's title always contains its own name,
    // so a single self-named marker would be satisfied by an empty shell.
    const violations = checkRouteShape(
      manifestWithPosts(),
      SHELL,
      () => "<html><head><title>Posts | App</title></head><body></body></html>",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("boundary is too high");
    expect(violations[0]?.problem).toContain('"Dashboard"');
  });

  it("names only the markup that went missing", () => {
    const violations = checkRouteShape(
      manifestWithPosts(),
      SHELL,
      () => "<html><body><nav>Dashboard</nav></body></html>",
    );

    expect(violations[0]?.problem).toContain('"Posts"');
    expect(violations[0]?.problem).not.toContain('"Dashboard"');
  });

  it("reports the shell size, so a near-empty page is obvious in the log", () => {
    const violations = checkRouteShape(
      manifestWithPosts(),
      SHELL,
      () => "<html></html>",
    );

    expect(violations[0]?.problem).toContain("prerendered 13 bytes");
  });

  it("catches a shell route that went fully dynamic", () => {
    // Nothing prerendered for it at all — a dynamic read escaped every
    // Suspense boundary, so there is no shell to serve.
    const manifest = goodManifest();
    delete manifest.routes["/posts"];

    const violations = check(manifest, SHELL, () => null);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("built as fully dynamic");
  });

  it("distinguishes a missing HTML file from a missing manifest entry", () => {
    const violations = checkRouteShape(manifestWithPosts(), SHELL, () => null);

    expect(violations[0]?.problem).toContain("no prerendered HTML was written");
  });

  it("does not require shell markup that was never asked for", () => {
    const violations = checkRouteShape(
      manifestWithPosts(),
      [{ route: "/posts", kind: "shell", because: "exists" }],
      () => "",
    );

    expect(violations).toEqual([]);
  });
});

describe("createShellReader", () => {
  it("returns null rather than throwing when a route has no prerendered HTML", () => {
    expect(createShellReader("does-not-exist")("/posts")).toBeNull();
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

    const output = formatViolations(check(manifest));

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
