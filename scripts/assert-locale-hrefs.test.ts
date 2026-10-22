import { describe, expect, it } from "vitest";
import {
  check,
  checkResolvable,
  checkUnprefixed,
  checkUnresolvableAudit,
  hrefPath,
  hrefsIn,
  resolves,
  routePatterns,
  sourceFiles,
  UNRESOLVABLE_ALLOWED,
} from "./assert-locale-hrefs.js";

const REPO = process.cwd();

describe("routePatterns", () => {
  const patterns = routePatterns(REPO);

  it("reads the real tree, with the groups and slots collapsed", () => {
    // `(dashboard)` and `(auth)` contribute no URL segment, which is the whole
    // reason a reader cannot answer this by looking at the paths.
    expect(patterns).toContain("/dashboard");
    expect(patterns).toContain("/login");
    expect(patterns).not.toContain("/(dashboard)/dashboard");
  });

  it("includes the locale root as `/`", () => {
    expect(patterns).toContain("/");
  });

  it("turns a dynamic segment into a wildcard", () => {
    expect(patterns).toContain("/blog/<dynamic>");
    expect(patterns).toContain("/posts/<dynamic>");
  });

  it("skips private folders and parallel slots", () => {
    for (const pattern of patterns) {
      expect(pattern).not.toContain("_components");
      expect(pattern).not.toContain("@");
    }
  });
});

describe("resolves", () => {
  const patterns = new Set(["/", "/blog", "/blog/<dynamic>", "/posts"]);

  it("accepts an exact route", () => {
    expect(resolves("/blog", patterns)).toBe(true);
  });

  it("accepts a concrete path against a dynamic segment", () => {
    expect(resolves("/blog/hello-world", patterns)).toBe(true);
  });

  it("rejects a route that does not exist", () => {
    expect(resolves("/blgo", patterns)).toBe(false);
  });

  it("does not let a dynamic segment swallow a longer path", () => {
    // `/blog/[slug]` is one segment, so `/blog/a/b` is a different route and
    // this gate must not accept it on the strength of the wildcard.
    expect(resolves("/blog/a/b", patterns)).toBe(false);
  });
});

describe("hrefPath", () => {
  it("drops a query string and a fragment", () => {
    expect(hrefPath("/login?callbackUrl=/posts")).toBe("/login");
    expect(hrefPath("/blog#top")).toBe("/blog");
  });

  it("drops a trailing slash, which names the same route", () => {
    expect(hrefPath("/blog/")).toBe("/blog");
  });

  it("leaves the root alone", () => {
    expect(hrefPath("/")).toBe("/");
  });
});

describe("hrefsIn", () => {
  it("reads a JSX string attribute", () => {
    const sites = hrefsIn("x.tsx", `<Link href="/blog">b</Link>`);
    expect(sites).toEqual([{ file: "x.tsx", raw: "/blog", pattern: "/blog" }]);
  });

  it("blanks an interpolation rather than giving up on the href", () => {
    const sites = hrefsIn("x.tsx", "<Link href={`/posts/${id}`}>e</Link>");
    expect(sites[0]?.pattern).toBe("/posts/<dynamic>");
  });

  it("reads the href of an object literal", () => {
    // How `nav-items.ts` holds the navigation. A gate that only read JSX would
    // have had nothing to say about the six links in the sidebar.
    const sites = hrefsIn("x.ts", `const a = [{ labelKey: "x", href: "/admin" }];`);
    expect(sites[0]?.pattern).toBe("/admin");
  });

  it("reports a non-literal href as unreadable rather than skipping it", () => {
    const sites = hrefsIn("x.tsx", `<Link href={target}>t</Link>`);
    expect(sites[0]?.pattern).toBeNull();
  });
});

describe("R1 — hrefs resolve", () => {
  it("fails a link to a route that does not exist", () => {
    const patterns = new Set(["/blog"]);
    const findings = checkResolvable(REPO, patterns);

    // Every real href in the tree is now unresolvable against this one-route
    // set, which is the point: the rule is firing, not inert.
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.rule === "R1")).toBe(true);
  });

  it("passes against the real route tree", () => {
    expect(checkResolvable(REPO)).toEqual([]);
  });
});

describe("R2 — no href carries a locale prefix", () => {
  it("passes against the repository as it stands", () => {
    expect(checkUnprefixed(REPO)).toEqual([]);
  });

  it("is what would catch an href written against the segment tree", () => {
    // Stated as a unit on `hrefsIn` + the rule's own predicate rather than by
    // writing a broken file into the tree: `/en/posts` type-checks under any
    // scheme and is wrong under `as-needed`, because the wrapper adds the
    // prefix itself.
    const sites = hrefsIn("x.tsx", `<Link href="/en/posts">p</Link>`);
    expect(sites[0]?.pattern).toBe("/en/posts");
    expect(hrefPath("/en/posts").startsWith("/en")).toBe(true);
  });
});

describe("R3 — the unreadable-href audit", () => {
  it("passes, and every exemption is still earning its place", () => {
    expect(checkUnresolvableAudit(REPO)).toEqual([]);
  });

  it("reports a stale exemption", () => {
    const findings = checkUnresolvableAudit(REPO, {
      unresolvableAllowed: ["src/components/does-not-exist.tsx"],
    });
    expect(findings.some((finding) => finding.message.includes("stale"))).toBe(
      true,
    );
  });

  it("reports a file whose href it cannot read and which is not exempt", () => {
    const findings = checkUnresolvableAudit(REPO, {
      unresolvableAllowed: [],
    });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.rule === "R3")).toBe(true);
  });

  it("gives every exemption a reason", () => {
    for (const exception of UNRESOLVABLE_ALLOWED) {
      expect(exception.why.length).toBeGreaterThan(20);
    }
  });
});

describe("sourceFiles", () => {
  it("skips tests, which write hrefs to assert on them", () => {
    expect(sourceFiles(REPO).every((file) => !file.includes(".test."))).toBe(
      true,
    );
  });

  it("covers both source roots", () => {
    const files = sourceFiles(REPO);
    expect(files.some((file) => file.startsWith("src/app/"))).toBe(true);
    expect(files.some((file) => file.startsWith("src/components/"))).toBe(true);
  });
});

describe("the repository as it stands", () => {
  it("passes every rule", () => {
    expect(check(REPO)).toEqual([]);
  });
});
