import { describe, it, expect, beforeEach } from "vitest";
import {
  MANIFEST_FILE,
  MANIFEST_VERSION,
  loadManifest,
  manifestPath,
  parseManifest,
  resetManifestCache,
  resolveShell,
} from "@/lib/security/shell-hashes";
import type { ShellHashManifest } from "@/lib/security/shell-hashes";

const manifest: ShellHashManifest = {
  version: MANIFEST_VERSION,
  buildId: "build-1",
  universal: ["NOTFOUND="],
  exact: {
    "/": { hashes: ["HOME="], regenerates: false },
    "/blog": { hashes: ["BLOG="], regenerates: true },
    "/pricing/v/control": { hashes: ["CONTROL="], regenerates: false },
  },
  dynamic: [
    {
      route: "/blog/[slug]",
      regex: "^/blog/([^/]+?)(?:/)?$",
      hashes: ["SLUG="],
      regenerates: true,
    },
    {
      route: "/photos/[id]",
      regex: "^/photos/([^/]+?)(?:/)?$",
      hashes: ["PHOTO="],
      regenerates: false,
    },
  ],
};

describe("resolveShell", () => {
  it("always includes the universal digests", () => {
    // `_not-found` answers a URL that matches nothing, so it can never be
    // looked up by path.
    expect(resolveShell(manifest, "/nothing-here").hashes).toEqual([
      "NOTFOUND=",
    ]);
  });

  it("finds an exact path", () => {
    expect(resolveShell(manifest, "/").hashes).toEqual(["NOTFOUND=", "HOME="]);
  });

  it("normalises a trailing slash", () => {
    expect(resolveShell(manifest, "/pricing/v/control/").hashes).toContain(
      "CONTROL=",
    );
  });

  it("falls back to a dynamic route's regex", () => {
    expect(resolveShell(manifest, "/photos/ocean").hashes).toContain("PHOTO=");
  });

  it("unions the requested and the served path", () => {
    // `/pricing` is rewritten to a variant, and it is the variant's document
    // that is served.
    const resolved = resolveShell(manifest, "/pricing", "/pricing/v/control");
    expect(resolved.hashes).toContain("CONTROL=");
  });

  it("reports a regenerating document as regenerating", () => {
    expect(resolveShell(manifest, "/blog").regenerates).toBe(true);
    expect(resolveShell(manifest, "/blog/anything").regenerates).toBe(true);
    expect(resolveShell(manifest, "/").regenerates).toBe(false);
  });

  it("takes the stricter answer when a rewrite is involved", () => {
    // One of the two documents being regenerated is enough: a digest-based
    // policy is unsafe for the request either way.
    expect(resolveShell(manifest, "/", "/blog").regenerates).toBe(true);
  });

  it("returns no digests and no regeneration for an unknown path", () => {
    const resolved = resolveShell(manifest, "/api/health");
    expect(resolved.hashes).toEqual(["NOTFOUND="]);
    expect(resolved.regenerates).toBe(false);
  });

  it("survives a malformed regex in the manifest", () => {
    const broken: ShellHashManifest = {
      ...manifest,
      dynamic: [
        { route: "/x/[y]", regex: "([", hashes: ["X="], regenerates: false },
      ],
    };
    expect(() => resolveShell(broken, "/x/y")).not.toThrow();
    expect(resolveShell(broken, "/x/y").hashes).toEqual(["NOTFOUND="]);
  });
});

describe("parseManifest", () => {
  it("accepts the shape the emitter writes", () => {
    expect(parseManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(
      manifest,
    );
  });

  it("rejects another version", () => {
    expect(parseManifest({ ...manifest, version: 99 })).toBeUndefined();
  });

  it("rejects an entry with no regeneration flag", () => {
    // The flag decides whether a path gets `'unsafe-inline'`, so a manifest that
    // does not carry it is not a manifest this code can act on.
    expect(
      parseManifest({ ...manifest, exact: { "/": { hashes: [] } } }),
    ).toBeUndefined();
  });

  it("rejects non-string digests, a missing regex, and a non-object", () => {
    expect(
      parseManifest({
        ...manifest,
        exact: { "/": { hashes: [1], regenerates: false } },
      }),
    ).toBeUndefined();
    expect(
      parseManifest({
        ...manifest,
        dynamic: [{ route: "/x", hashes: [], regenerates: false }],
      }),
    ).toBeUndefined();
    expect(parseManifest("nope")).toBeUndefined();
    expect(parseManifest(null)).toBeUndefined();
  });
});

describe("loadManifest", () => {
  beforeEach(() => {
    resetManifestCache();
  });

  it("reads and caches the file", () => {
    let reads = 0;
    const read = (): string => {
      reads += 1;
      return JSON.stringify(manifest);
    };

    expect(loadManifest({ nextDir: ".next", read })?.buildId).toBe("build-1");
    expect(loadManifest({ nextDir: ".next", read })?.buildId).toBe("build-1");
    expect(reads).toBe(1);
  });

  it("caches the absence too, so a missing file is read once", () => {
    let reads = 0;
    const read = (): string => {
      reads += 1;
      throw new Error("ENOENT");
    };

    expect(loadManifest({ nextDir: ".next", read })).toBeUndefined();
    expect(loadManifest({ nextDir: ".next", read })).toBeUndefined();
    expect(reads).toBe(1);
  });

  it("returns undefined for unparseable JSON rather than throwing", () => {
    expect(
      loadManifest({ nextDir: ".next", read: () => "{not json" }),
    ).toBeUndefined();
  });
});

describe("manifestPath", () => {
  it("sits inside the build directory", () => {
    expect(manifestPath("/app/.next")).toBe(`/app/.next/${MANIFEST_FILE}`);
  });
});
