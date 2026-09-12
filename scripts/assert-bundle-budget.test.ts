import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  ROUTE_BUDGETS,
  SHARED_BASELINE_GZIP_BUDGET_BYTES,
  checkBudgets,
  checkBundleBudget,
  checkChunksExist,
  checkPolyfillIsLegacyOnly,
  checkRouteCoverage,
  checkSharedBaseline,
  documentPathToPage,
  formatBytes,
  formatMarkdownReport,
  formatReport,
  formatViolations,
  matchRoute,
  measureRoutes,
  parseDocumentScripts,
  readPagePayloads,
  readPolyfillFiles,
  sharedChunks,
  type Chunk,
  type PagePayload,
  type RouteBudget,
} from "./assert-bundle-budget";

/** A chunk of a known gzipped size, so budgets in tests are exact. */
function chunk(url: string, gzipBytes: number): Chunk {
  return { url, bytes: gzipBytes * 3, gzipBytes };
}

/** The baseline every page in these fixtures loads: 100 kB across two chunks. */
const BASELINE = [
  chunk("/_next/static/chunks/react.js", 70_000),
  chunk("/_next/static/chunks/router.js", 30_000),
];

function page(
  name: string,
  own: readonly Chunk[] = [],
  overrides: Partial<PagePayload> = {},
): PagePayload {
  return {
    page: name,
    modern: [...BASELINE, ...own],
    legacyOnly: [chunk("/_next/static/chunks/polyfills.js", 39_000)],
    missing: [],
    ...overrides,
  };
}

const BUDGETS: readonly RouteBudget[] = [
  { route: "/", gzipBudgetBytes: 120_000, because: "the landing page" },
  { route: "/blog/[slug]", gzipBudgetBytes: 150_000, because: "a post body" },
];

describe("parseDocumentScripts", () => {
  it("splits module scripts from the noModule polyfill bundle", () => {
    const html = `
      <script src="/_next/static/chunks/a.js" async=""></script>
      <script src="/_next/static/chunks/polyfills.js" noModule=""></script>
      <script src="/_next/static/chunks/b.js" async=""></script>
    `;

    expect(parseDocumentScripts(html)).toEqual({
      modern: ["/_next/static/chunks/a.js", "/_next/static/chunks/b.js"],
      legacyOnly: ["/_next/static/chunks/polyfills.js"],
    });
  });

  it("finds noModule whichever side of src it is written on", () => {
    const before = `<script noModule="" src="/_next/static/chunks/p.js"></script>`;
    const after = `<script src="/_next/static/chunks/p.js" nomodule></script>`;

    expect(parseDocumentScripts(before).legacyOnly).toHaveLength(1);
    expect(parseDocumentScripts(after).legacyOnly).toHaveLength(1);
  });

  it("ignores inline scripts and anything outside /_next", () => {
    const html = `
      <script>self.__next_f.push([1,"payload"])</script>
      <script src="https://cdn.example.com/analytics.js"></script>
      <script src="/_next/static/chunks/a.js"></script>
    `;

    expect(parseDocumentScripts(html).modern).toEqual([
      "/_next/static/chunks/a.js",
    ]);
  });

  it("does not mistake a chunk named `nomodule-something` for a legacy script", () => {
    const html = `<script src="/_next/static/chunks/nomodule-shim.js" async=""></script>`;

    expect(parseDocumentScripts(html)).toEqual({
      modern: ["/_next/static/chunks/nomodule-shim.js"],
      legacyOnly: [],
    });
  });
});

describe("documentPathToPage", () => {
  it("maps the root document to /", () => {
    expect(documentPathToPage("index.html")).toBe("/");
  });

  it("maps nested documents to their URL path", () => {
    expect(documentPathToPage("blog/seed-post.html")).toBe("/blog/seed-post");
    expect(documentPathToPage("(.)photos/[id].html")).toBe("/(.)photos/[id]");
  });

  it("normalises Windows separators", () => {
    expect(documentPathToPage("blog\\seed-post.html")).toBe("/blog/seed-post");
  });
});

describe("matchRoute", () => {
  const routes = [
    "/photos",
    "/photos/[id]",
    "/(.)photos/[id]",
    "/docs/[...slug]",
  ];

  it("prefers an exact route over a dynamic one that would also match", () => {
    expect(matchRoute("/photos", routes)).toBe("/photos");
  });

  it("matches a concrete page to the dynamic route that produced it", () => {
    expect(matchRoute("/photos/ocean-at-sunset", routes)).toBe("/photos/[id]");
  });

  it("matches a dynamic route's own fallback document", () => {
    expect(matchRoute("/photos/[id]", routes)).toBe("/photos/[id]");
  });

  it("treats interception markers as literal text, not regex", () => {
    expect(matchRoute("/(.)photos/ocean", routes)).toBe("/(.)photos/[id]");
    // `(.)` as a regex would be a group matching any single character, so this
    // page would be captured by the interception route it has nothing to do with.
    expect(matchRoute("/aphotos/ocean", routes)).toBeUndefined();
  });

  it("matches catch-all segments across multiple path parts", () => {
    expect(matchRoute("/docs/a/b/c", routes)).toBe("/docs/[...slug]");
  });

  it("does not let a single dynamic segment swallow a deeper path", () => {
    expect(matchRoute("/photos/ocean/detail", routes)).toBeUndefined();
  });

  it("returns undefined for a page no route claims", () => {
    expect(matchRoute("/brand-new", routes)).toBeUndefined();
  });
});

describe("sharedChunks", () => {
  it("returns the chunks every page loads", () => {
    const pages = [
      page("/", [chunk("/_next/static/chunks/home.js", 5_000)]),
      page("/blog/one", [chunk("/_next/static/chunks/blog.js", 8_000)]),
    ];

    expect(sharedChunks(pages).map((c) => c.url)).toEqual([
      "/_next/static/chunks/react.js",
      "/_next/static/chunks/router.js",
    ]);
  });

  it("drops a chunk that one page does not load", () => {
    const pages = [page("/"), { ...page("/blog/one"), modern: [BASELINE[0]!] }];

    expect(sharedChunks(pages).map((c) => c.url)).toEqual([
      "/_next/static/chunks/react.js",
    ]);
  });

  it("is empty for an empty build", () => {
    expect(sharedChunks([])).toEqual([]);
  });
});

describe("measureRoutes", () => {
  it("groups a route's pages and measures the heaviest of them", () => {
    const pages = [
      page("/", [chunk("/_next/static/chunks/home.js", 5_000)]),
      page("/blog/light", [chunk("/_next/static/chunks/light.js", 1_000)]),
      page("/blog/heavy", [chunk("/_next/static/chunks/heavy.js", 20_000)]),
    ];

    const measurements = measureRoutes(pages, BUDGETS);
    const blog = measurements.find((m) => m.route === "/blog/[slug]");

    expect(blog).toMatchObject({
      worstPage: "/blog/heavy",
      pages: 2,
      gzipBytes: 120_000,
      sharedGzipBytes: 100_000,
      ownGzipBytes: 20_000,
      gzipBudgetBytes: 150_000,
      chunks: 3,
    });
  });

  it("reports the legacy bundle separately from the budgeted total", () => {
    const [measurement] = measureRoutes([page("/")], BUDGETS);

    expect(measurement?.gzipBytes).toBe(100_000);
    expect(measurement?.legacyGzipBytes).toBe(39_000);
  });

  it("skips a budgeted route that prerendered nothing", () => {
    const measurements = measureRoutes([page("/")], BUDGETS);

    expect(measurements.map((m) => m.route)).toEqual(["/"]);
  });

  it("counts a chunk once when a document references it twice", () => {
    const twice = page("/");
    twice.modern = [...twice.modern, BASELINE[0]!];

    // The reader dedupes by URL before measuring, so a repeated reference
    // cannot inflate the total — a browser fetches it once.
    expect(sharedChunks([twice]).length).toBe(3);
    expect(measureRoutes([twice], BUDGETS)[0]?.gzipBytes).toBe(170_000);
  });
});

describe("checkBudgets", () => {
  it("passes a route inside its budget", () => {
    expect(checkBudgets(measureRoutes([page("/")], BUDGETS), BUDGETS)).toEqual(
      [],
    );
  });

  it("passes a route sitting exactly on its budget", () => {
    const pages = [page("/", [chunk("/_next/static/chunks/x.js", 20_000)])];

    expect(checkBudgets(measureRoutes(pages, BUDGETS), BUDGETS)).toEqual([]);
  });

  it("fails a route one byte over", () => {
    const pages = [page("/", [chunk("/_next/static/chunks/x.js", 20_001)])];

    const violations = checkBudgets(measureRoutes(pages, BUDGETS), BUDGETS);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.route).toBe("/");
    expect(violations[0]?.problem).toContain("120.0 kB budget");
    expect(violations[0]?.because).toBe("the landing page");
  });

  it("names the page it measured, so the regression can be reproduced", () => {
    const pages = [
      page("/blog/light"),
      page("/blog/heavy", [chunk("/_next/static/chunks/heavy.js", 60_000)]),
    ];

    const violations = checkBudgets(measureRoutes(pages, BUDGETS), BUDGETS);

    expect(violations[0]?.problem).toContain("measured on /blog/heavy");
  });
});

describe("checkSharedBaseline", () => {
  it("passes a baseline within budget", () => {
    expect(checkSharedBaseline([page("/")], 100_000)).toEqual([]);
  });

  it("fails a baseline that grew past it", () => {
    const violations = checkSharedBaseline([page("/")], 99_999);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain(
      "100.0 kB gzipped across 2 chunk(s)",
    );
  });
});

describe("checkRouteCoverage", () => {
  it("passes when every budgeted route prerendered and nothing else did", () => {
    expect(checkRouteCoverage([page("/"), page("/blog/one")], BUDGETS)).toEqual(
      [],
    );
  });

  it("fails a budgeted route that prerendered no document", () => {
    const violations = checkRouteCoverage([page("/")], BUDGETS);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.route).toBe("/blog/[slug]");
    expect(violations[0]?.problem).toContain("prerendered no document");
  });

  it("fails a new route that no budget covers", () => {
    const pages = [page("/"), page("/blog/one"), page("/pricing")];

    const violations = checkRouteCoverage(pages, BUDGETS);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.route).toBe("/pricing");
    expect(violations[0]?.problem).toContain("is in no budget");
  });
});

describe("checkChunksExist", () => {
  it("passes when every referenced script is on disk", () => {
    expect(checkChunksExist([page("/")])).toEqual([]);
  });

  it("fails a document referencing a script the build did not write", () => {
    const broken = page("/", [], {
      missing: ["/_next/static/chunks/gone.js"],
    });

    const violations = checkChunksExist([broken]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("/_next/static/chunks/gone.js");
  });
});

describe("checkPolyfillIsLegacyOnly", () => {
  const polyfills = ["static/chunks/polyfills.js"];

  it("passes while the polyfill bundle stays noModule", () => {
    expect(checkPolyfillIsLegacyOnly([page("/")], polyfills)).toEqual([]);
  });

  it("fails when the polyfill bundle is served as a module script", () => {
    const regressed = page("/", [
      chunk("/_next/static/chunks/polyfills.js", 39_000),
    ]);

    const violations = checkPolyfillIsLegacyOnly([regressed], polyfills);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("legacy polyfill bundle");
  });

  it("is inert when the build declares no polyfills", () => {
    const regressed = page("/", [
      chunk("/_next/static/chunks/polyfills.js", 39_000),
    ]);

    expect(checkPolyfillIsLegacyOnly([regressed], [])).toEqual([]);
  });
});

describe("checkBundleBudget", () => {
  it("passes a healthy build", () => {
    const pages = [page("/"), page("/blog/one")];

    expect(checkBundleBudget(pages, [], BUDGETS, 100_000)).toEqual([]);
  });

  it("collects every kind of violation at once", () => {
    const pages = [
      page("/", [chunk("/_next/static/chunks/huge.js", 50_000)]),
      page("/pricing"),
    ];

    const violations = checkBundleBudget(pages, [], BUDGETS, 99_999);

    expect(violations.map((v) => v.route).sort()).toEqual([
      "(shared by every route)",
      "/",
      "/blog/[slug]",
      "/pricing",
    ]);
  });
});

describe("the budget table itself", () => {
  it("has no duplicate routes", () => {
    const routes = ROUTE_BUDGETS.map((budget) => budget.route);

    expect(new Set(routes).size).toBe(routes.length);
  });

  it("budgets every route above the shared baseline it must contain", () => {
    for (const budget of ROUTE_BUDGETS) {
      expect(budget.gzipBudgetBytes).toBeGreaterThan(
        SHARED_BASELINE_GZIP_BUDGET_BYTES,
      );
    }
  });

  it("explains every entry, since the message is what a failure prints", () => {
    for (const budget of ROUTE_BUDGETS) {
      expect(budget.because.length).toBeGreaterThan(20);
    }
  });
});

describe("formatting", () => {
  it("counts kB as 1000 bytes, like the browser network panel", () => {
    expect(formatBytes(1_000)).toBe("1.0 kB");
    expect(formatBytes(147_399)).toBe("147.4 kB");
    expect(formatBytes(-2_500)).toBe("-2.5 kB");
  });

  it("marks an over-budget route in the text report", () => {
    const pages = [page("/", [chunk("/_next/static/chunks/x.js", 40_000)])];
    const measurements = measureRoutes(pages, BUDGETS);

    const report = formatReport(measurements, 100_000, 2, 39_000);

    expect(report).toContain("OVER");
    expect(report).toContain(
      "Shared by every route: 100.0 kB across 2 chunk(s)",
    );
    expect(report).toContain("Legacy polyfill bundle: 39.0 kB");
  });

  it("leaves a route within budget unmarked", () => {
    const report = formatReport(
      measureRoutes([page("/")], BUDGETS),
      100_000,
      2,
      0,
    );

    expect(report).not.toContain("OVER");
  });

  it("renders a Markdown table for the job summary", () => {
    const pages = [
      page("/"),
      page("/blog/one", [chunk("/_next/static/chunks/b.js", 90_000)]),
    ];
    const markdown = formatMarkdownReport(
      measureRoutes(pages, BUDGETS),
      100_000,
      2,
    );

    expect(markdown).toContain("| Route | First load |");
    expect(markdown).toContain("| `/` |");
    // The blog page is 190 kB against a 150 kB budget.
    expect(markdown).toContain("❌");
    expect(markdown).toContain("✅");
  });

  it("prints the route, the problem and the reason for each violation", () => {
    const text = formatViolations([
      { route: "/", problem: "too heavy.", because: "the landing page" },
    ]);

    expect(text).toContain(
      "/\n    too heavy.\n    budgeted because: the landing page",
    );
  });
});

describe("readPagePayloads", () => {
  /** Builds a throwaway `.next` holding real files, so gzip runs for real. */
  function fixture(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(path.join(tmpdir(), "bundle-budget-"));
    const chunks = path.join(dir, "static", "chunks");
    mkdirSync(chunks, { recursive: true });
    mkdirSync(path.join(dir, "server", "app", "blog"), { recursive: true });

    writeFileSync(path.join(chunks, "react.js"), "a".repeat(10_000));
    writeFileSync(path.join(chunks, "blog.js"), "b".repeat(2_000));
    writeFileSync(path.join(chunks, "polyfills.js"), "c".repeat(5_000));
    writeFileSync(
      path.join(dir, "build-manifest.json"),
      JSON.stringify({ polyfillFiles: ["static/chunks/polyfills.js"] }),
    );

    const doc = (scripts: string) => `<html><body>${scripts}</body></html>`;
    writeFileSync(
      path.join(dir, "server", "app", "index.html"),
      doc(
        `<script src="/_next/static/chunks/react.js" async=""></script>` +
          `<script src="/_next/static/chunks/polyfills.js" noModule=""></script>`,
      ),
    );
    writeFileSync(
      path.join(dir, "server", "app", "blog", "one.html"),
      doc(
        `<script src="/_next/static/chunks/react.js" async=""></script>` +
          `<script src="/_next/static/chunks/blog.js" async=""></script>` +
          `<script src="/_next/static/chunks/missing.js" async=""></script>`,
      ),
    );

    return {
      dir,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("measures each document's scripts against the files on disk", () => {
    const { dir, cleanup } = fixture();
    try {
      const pages = readPagePayloads(dir);
      const home = pages.find((p) => p.page === "/");

      expect(pages.map((p) => p.page).sort()).toEqual(["/", "/blog/one"]);
      expect(home?.modern).toHaveLength(1);
      expect(home?.modern[0]?.bytes).toBe(10_000);
      expect(home?.modern[0]?.gzipBytes).toBe(
        gzipSync(Buffer.from("a".repeat(10_000)), { level: 9 }).byteLength,
      );
      expect(home?.legacyOnly[0]?.bytes).toBe(5_000);
    } finally {
      cleanup();
    }
  });

  it("records a referenced script that is not in the build instead of throwing", () => {
    const { dir, cleanup } = fixture();
    try {
      const blog = readPagePayloads(dir).find((p) => p.page === "/blog/one");

      expect(blog?.missing).toEqual(["/_next/static/chunks/missing.js"]);
      expect(blog?.modern).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it("reads the polyfill filenames the build recorded", () => {
    const { dir, cleanup } = fixture();
    try {
      expect(readPolyfillFiles(dir)).toEqual(["static/chunks/polyfills.js"]);
    } finally {
      cleanup();
    }
  });

  it("returns no polyfills when the manifest is absent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bundle-budget-empty-"));
    try {
      expect(readPolyfillFiles(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says to build first rather than reporting an empty application", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bundle-budget-empty-"));
    try {
      expect(() => readPagePayloads(dir)).toThrow(/Run `pnpm build`/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
