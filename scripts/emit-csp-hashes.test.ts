import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { MANIFEST_VERSION } from "@/lib/security/shell-hashes";
import {
  UNIVERSAL_DOCUMENTS,
  buildManifest,
  digest,
  documentHashes,
  dynamicRouteRegexes,
  inlineScripts,
  isDynamicRoute,
  revalidatingRoutes,
  routeRegex,
  servedPath,
} from "./emit-csp-hashes";
import type { PrerenderedDocument } from "./emit-csp-hashes";

function document(route: string, ...bodies: string[]): PrerenderedDocument {
  return {
    route,
    html:
      "<!DOCTYPE html><html><body>" +
      '<script src="/_next/static/chunks/main.js" async=""></script>' +
      bodies.map((body) => `<script>${body}</script>`).join("") +
      "</body></html>",
  };
}

const sha256 = (body: string): string =>
  createHash("sha256").update(body, "utf8").digest("base64");

describe("inlineScripts", () => {
  it("returns the bodies of the scripts with no src", () => {
    expect(inlineScripts(document("/", "a=1", "b=2").html)).toEqual([
      "a=1",
      "b=2",
    ]);
  });

  it("skips a tag with a src, whatever else it carries", () => {
    expect(
      inlineScripts('<script src="/a.js" nonce="x" async=""></script>'),
    ).toEqual([]);
  });

  it("skips an empty inline tag, which has nothing to authorise", () => {
    expect(inlineScripts("<script></script>")).toEqual([]);
  });

  it("does not trim, because a browser hashes the bytes as written", () => {
    expect(inlineScripts("<script>\n  a = 1;\n</script>")).toEqual([
      "\n  a = 1;\n",
    ]);
  });

  it("stops at the first closing tag", () => {
    // React escapes a `</script>` inside a string literal (`<\/script>`), which
    // is what makes a non-greedy match see the same bytes the browser hashes.
    expect(
      inlineScripts('<script>a="<\\/script>"</script><script>b=2</script>'),
    ).toEqual(['a="<\\/script>"', "b=2"]);
  });
});

describe("digest", () => {
  it("is base64 sha-256 of the body", () => {
    expect(digest("a=1")).toBe(sha256("a=1"));
  });

  it("de-duplicates identical scripts in one document", () => {
    // The bootstrap line is byte-identical in every document; one digest covers
    // every copy of it.
    expect(documentHashes(document("/", "same", "same").html)).toEqual([
      sha256("same"),
    ]);
  });
});

describe("servedPath", () => {
  it("strips an interception marker from the segment it is glued to", () => {
    // `(.)photos/[id]` is served at `/photos/[id]`, so its digests belong there.
    expect(servedPath("/(.)photos/[id]")).toBe("/photos/[id]");
    expect(servedPath("/(..)(..)photos/[id]")).toBe("/photos/[id]");
  });

  it("drops a route group", () => {
    expect(servedPath("/(auth)/login")).toBe("/login");
  });

  it("leaves an ordinary path alone", () => {
    expect(servedPath("/blog/[slug]")).toBe("/blog/[slug]");
    expect(servedPath("/")).toBe("/");
  });
});

describe("routeRegex", () => {
  it("prefers the expression the build recorded", () => {
    expect(
      routeRegex("/blog/[slug]", {
        "/blog/[slug]": "^/blog/([^/]+?)(?:/)?$",
      }),
    ).toBe("^/blog/([^/]+?)(?:/)?$");
  });

  it("derives one that matches a real request path", () => {
    const derived = routeRegex("/photos/[id]", {});
    expect(new RegExp(derived).test("/photos/ocean")).toBe(true);
    expect(new RegExp(derived).test("/photos/ocean/extra")).toBe(false);
  });

  it("derives a catch-all that spans segments", () => {
    const derived = routeRegex("/docs/[...path]", {});
    expect(new RegExp(derived).test("/docs/a/b/c")).toBe(true);
  });

  it("escapes the literal segments", () => {
    const derived = routeRegex("/a.b/[id]", {});
    expect(new RegExp(derived).test("/axb/1")).toBe(false);
    expect(new RegExp(derived).test("/a.b/1")).toBe(true);
  });
});

describe("revalidatingRoutes", () => {
  it("picks out the routes with a window, in both groups", () => {
    const manifest = {
      routes: {
        "/": { initialRevalidateSeconds: false },
        "/blog": { initialRevalidateSeconds: 60 },
      },
      dynamicRoutes: {
        "/blog/[slug]": { initialRevalidateSeconds: 300 },
        "/photos/[id]": { initialRevalidateSeconds: false },
      },
    };

    expect([...revalidatingRoutes(manifest)].sort()).toEqual([
      "/blog",
      "/blog/[slug]",
    ]);
  });

  it("is empty for a manifest it cannot read", () => {
    expect(revalidatingRoutes(undefined).size).toBe(0);
    expect(revalidatingRoutes({ routes: "nope" }).size).toBe(0);
  });
});

describe("dynamicRouteRegexes", () => {
  it("reads routeRegex per dynamic route", () => {
    expect(
      dynamicRouteRegexes({
        dynamicRoutes: { "/a/[b]": { routeRegex: "^/a/([^/]+?)$" } },
      }),
    ).toEqual({ "/a/[b]": "^/a/([^/]+?)$" });
  });

  it("ignores anything that is not a string", () => {
    expect(
      dynamicRouteRegexes({ dynamicRoutes: { "/a/[b]": { routeRegex: 7 } } }),
    ).toEqual({});
  });
});

describe("isDynamicRoute", () => {
  it("is about the bracket, which is what the build writes", () => {
    expect(isDynamicRoute("/blog/[slug]")).toBe(true);
    expect(isDynamicRoute("/blog")).toBe(false);
  });
});

describe("buildManifest", () => {
  const documents = [
    document("/", "home"),
    document("/blog", "blog"),
    document("/blog/[slug]", "slug-shell"),
    document("/(.)photos/[id]", "interception"),
    document("/photos/[id]", "photo-shell"),
    document("/_not-found", "notfound"),
  ];

  const manifest = buildManifest(documents, {
    buildId: "build-1",
    regexes: { "/blog/[slug]": "^/blog/([^/]+?)(?:/)?$" },
    revalidating: new Set(["/blog", "/blog/[slug]"]),
  });

  it("records the build it was emitted for", () => {
    expect(manifest.version).toBe(MANIFEST_VERSION);
    expect(manifest.buildId).toBe("build-1");
  });

  it("puts the error documents in the universal set", () => {
    // A 404 answers a URL that matches nothing, so it can never be looked up.
    expect(manifest.universal).toEqual([sha256("notfound")]);
    expect(UNIVERSAL_DOCUMENTS).toContain("/_not-found");
  });

  it("keys a fixed document by its path", () => {
    expect(manifest.exact["/"]).toEqual({
      hashes: [sha256("home")],
      regenerates: false,
    });
  });

  it("marks a revalidating route as regenerating", () => {
    expect(manifest.exact["/blog"]?.regenerates).toBe(true);
  });

  it("keys a dynamic shell by the regex a request path matches", () => {
    const blog = manifest.dynamic.find(
      (shell) => shell.route === "/blog/[slug]",
    );
    expect(blog?.regex).toBe("^/blog/([^/]+?)(?:/)?$");
    expect(blog?.regenerates).toBe(true);
  });

  it("merges an interception into the page it is served as", () => {
    // Both documents can answer `/photos/ocean`; which one arrives depends on how
    // the visitor got there, and a digest authorises only the bytes it names.
    const photos = manifest.dynamic.filter(
      (shell) => shell.route === "/photos/[id]",
    );
    expect(photos).toHaveLength(1);
    expect([...(photos[0]?.hashes ?? [])].sort()).toEqual(
      [sha256("interception"), sha256("photo-shell")].sort(),
    );
  });

  it("is stable across two builds of the same documents", () => {
    const again = buildManifest([...documents].reverse(), {
      buildId: "build-1",
      regexes: { "/blog/[slug]": "^/blog/([^/]+?)(?:/)?$" },
      revalidating: new Set(["/blog", "/blog/[slug]"]),
    });
    expect(Object.keys(again.exact)).toEqual(Object.keys(manifest.exact));
    expect(again.dynamic.map((shell) => shell.regex)).toEqual(
      manifest.dynamic.map((shell) => shell.regex),
    );
  });

  it("takes the stricter answer when two documents share a regex", () => {
    const merged = buildManifest(
      [document("/x/[id]", "a"), document("/(.)x/[id]", "b")],
      { buildId: "b", revalidating: new Set(["/x/[id]"]) },
    );
    expect(merged.dynamic).toHaveLength(1);
    expect(merged.dynamic[0]?.regenerates).toBe(true);
  });
});
