/**
 * Asserts that no route ships more JavaScript than it is budgeted, and reports
 * what every route actually costs.
 *
 * This gate exists because Next 16 stopped printing the number. The route table
 * `next build` writes today has columns for `Revalidate` and `Expire` and none
 * for `First Load JS` — the size column that used to make a bundle regression
 * visible to anyone reading the build log is simply gone under Turbopack. So
 * the only remaining signal for "this page got 80 kB heavier" is a user on a
 * slow connection, which is not a signal anyone in CI receives.
 *
 * What makes that dangerous here rather than merely untidy is how client
 * JavaScript arrives in an App Router application. It is not added by anyone
 * deciding to add it. A Server Component that imports a helper which imports a
 * module carrying `"use client"` pulls that module, and everything *it*
 * imports, into the browser bundle — no directive changes, no import statement
 * mentions a client component, and nothing in the diff looks like a bundle
 * change. The providers chunk in this build is 80 kB gzipped (TanStack Query
 * and Zod together) and reaches every route but `/_global-error` for exactly
 * that reason: it is imported once, in the root layout.
 *
 * So the payload is what we assert, measured from the documents the build
 * actually wrote rather than from a manifest describing them.
 *
 * Three properties of the measurement are worth stating, because each one is a
 * way this gate could have lied:
 *
 * 1. **`noModule` scripts are excluded from the budget.** Next emits its
 *    legacy polyfill bundle — 39 kB gzipped here — with a `noModule`
 *    attribute, so every browser that supports ES modules skips it entirely.
 *    Counting it would inflate every route by the same 39 kB and make the
 *    budgets describe a browser almost nobody uses. It is measured and printed
 *    separately, and `checkPolyfillIsLegacyOnly` fails if it ever loses the
 *    attribute — at which point it stops being free and every modern browser
 *    starts downloading it.
 *
 * 2. **Gzip, not raw bytes.** Raw bytes are what a minifier reports; gzip is
 *    what crosses the wire. The two move independently — a change that adds
 *    repetitive generated code can grow raw size by 30 kB and gzip by 2 kB —
 *    and it is the second number a user waits for. Brotli would be closer
 *    still for a CDN-served app, but gzip is available in every Node the
 *    matrix runs and is the conservative of the two.
 *
 * 3. **A route's budget is measured against its worst page.** `/blog/[slug]`
 *    prerenders four documents; they are one route with one budget, and the
 *    largest is the one a visitor can be unlucky enough to land on.
 *
 * Usage: tsx scripts/assert-bundle-budget.ts [path-to-.next]
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

/** One JavaScript file a document loads, with both of its sizes. */
export interface Chunk {
  /** URL as written in the document, e.g. `/_next/static/chunks/abc.js`. */
  url: string;
  bytes: number;
  gzipBytes: number;
}

/** One prerendered document, and the scripts it tells a browser to fetch. */
export interface PagePayload {
  /** URL path of this document, e.g. `/blog/seed-post-cache-life`. */
  page: string;
  /** Scripts a module-supporting browser loads — the ones that count. */
  modern: Chunk[];
  /** `noModule` scripts, which only a pre-2018 browser ever fetches. */
  legacyOnly: Chunk[];
  /** Scripts the document references that are not on disk. */
  missing: string[];
}

export interface RouteBudget {
  /**
   * Route pattern as the build writes it, dynamic segments included:
   * `/blog/[slug]`, not `/blog/seed-post-cache-life`.
   */
  route: string;
  /**
   * Ceiling for this route's first-load JavaScript, gzipped, in bytes.
   *
   * Every number here is the route's measured size rounded up to leave roughly
   * 5% of headroom. That is deliberate on both sides. Tighter and the gate
   * fails on compressor noise between Node majors; looser and a route can
   * absorb a whole library before anyone hears about it. Raising one is a
   * one-line diff that shows up in review as what it is — a decision to ship
   * more JavaScript — rather than something that happens by not noticing.
   */
  gzipBudgetBytes: number;
  /** What this route carries, and why that is the size it is. */
  because: string;
}

/**
 * Ceiling for the chunks every single route loads.
 *
 * This is React, React DOM and the App Router runtime: the cost of the first
 * page a visitor opens, before anything this application wrote. It is budgeted
 * separately from the routes because it moves for entirely different reasons —
 * a React upgrade, a Next upgrade, a change to the root layout — and because
 * folding it into 17 route budgets would mean 17 numbers moving at once with
 * nothing saying they moved together.
 *
 * Measured at 147,399 bytes gzipped across 7 chunks.
 */
export const SHARED_BASELINE_GZIP_BUDGET_BYTES = 155_000;

/**
 * Every route that prerenders a document, with what it may cost.
 *
 * Listed explicitly rather than derived, for the same reason the route-shape
 * gate lists its expectations: a budget computed from the build is not a
 * budget, it is a description. `checkRouteCoverage` closes the other half —
 * a new route that prerenders a document and is missing from this table fails
 * the gate instead of shipping unmeasured.
 *
 * API handlers are absent. They return data, load no client JavaScript, and
 * write no document to measure.
 */
export const ROUTE_BUDGETS: readonly RouteBudget[] = [
  {
    route: "/",
    gzipBudgetBytes: 260_000,
    because:
      "the landing page: baseline, providers, the theme toggle and the nav. " +
      "Nothing route-specific, so this is close to the floor for a page under the root layout",
  },
  {
    route: "/_not-found",
    gzipBudgetBytes: 248_000,
    because: "the 404 page renders markup and a link; it is the floor itself",
  },
  {
    route: "/_global-error",
    gzipBudgetBytes: 156_000,
    because:
      "the global error boundary replaces the root layout, so it is the one route that " +
      "loads no providers. It is the shared baseline plus 223 bytes — and the proof that " +
      "the 80 kB every other route pays is the providers, not the framework",
  },
  {
    route: "/forbidden",
    gzipBudgetBytes: 250_000,
    because: "the 403 page: markup and a link back, like the 404",
  },
  {
    route: "/login",
    gzipBudgetBytes: 262_000,
    because: "the credentials form and its client-side validation",
  },
  {
    route: "/register",
    gzipBudgetBytes: 262_000,
    because: "the registration form; the same shape as /login",
  },
  {
    route: "/blog",
    gzipBudgetBytes: 262_000,
    because: "the ISR post index: a server-rendered list, no client state",
  },
  {
    route: "/blog/[slug]",
    gzipBudgetBytes: 262_000,
    because:
      "a prerendered post body. Four documents are built from it and the largest is the one budgeted",
  },
  {
    route: "/photos",
    gzipBudgetBytes: 275_000,
    because: "the gallery grid, plus the client navigation the modal needs",
  },
  {
    route: "/photos/[id]",
    gzipBudgetBytes: 276_000,
    because: "a single photo page, reached directly rather than intercepted",
  },
  {
    route: "/(.)photos/[id]",
    gzipBudgetBytes: 275_000,
    because:
      "the intercepted modal. It renders the same photo inside the gallery route, " +
      "so it costs roughly what /photos/[id] does",
  },
  {
    route: "/dashboard",
    gzipBudgetBytes: 268_000,
    because:
      "four parallel slots streaming into one shell; the client cost is the router, not the data",
  },
  {
    route: "/posts",
    gzipBudgetBytes: 276_000,
    because: "the post table with its mutation forms",
  },
  {
    route: "/posts/[id]",
    gzipBudgetBytes: 280_000,
    because:
      "the heaviest route in the application: the editor form, optimistic concurrency and the conflict UI",
  },
  {
    route: "/admin",
    gzipBudgetBytes: 267_000,
    because: "the admin view; a table and the role-gated controls",
  },
  {
    route: "/images",
    gzipBudgetBytes: 276_000,
    because: "the next/image showcase — many images, little script",
  },
  {
    route: "/upload",
    gzipBudgetBytes: 270_000,
    because: "the upload form: file input, progress and client-side validation",
  },
];

export interface Violation {
  route: string;
  problem: string;
  because: string;
}

/** What one route measured, once its pages are grouped and compared. */
export interface RouteMeasurement {
  route: string;
  /** The page that measured largest — the one the budget is applied to. */
  worstPage: string;
  /** How many prerendered documents this route produced. */
  pages: number;
  gzipBytes: number;
  bytes: number;
  /** Of `gzipBytes`, how much is the baseline every route pays. */
  sharedGzipBytes: number;
  /** Of `gzipBytes`, how much is this route's own. */
  ownGzipBytes: number;
  gzipBudgetBytes: number;
  chunks: number;
  legacyGzipBytes: number;
}

/**
 * Pulls the scripts out of a prerendered document.
 *
 * Deliberately a regex rather than a parser. The input is machine-written
 * markup from one known generator, the attribute set is fixed, and a parser
 * would be a dependency and a second thing to keep current for no more
 * accuracy than this.
 *
 * The `noModule` split is the part that matters. React's DOM renderer writes
 * the attribute as `noModule=""`, so the match is case-insensitive and looks on
 * both sides of `src` — attribute order in the emitted tag is not something
 * this gate should depend on.
 */
export function parseDocumentScripts(html: string): {
  modern: string[];
  legacyOnly: string[];
} {
  const modern: string[] = [];
  const legacyOnly: string[] = [];

  const tags = html.matchAll(
    /<script([^>]*?)\ssrc="(\/_next\/[^"]+\.js)"([^>]*)>/gi,
  );

  for (const tag of tags) {
    const url = tag[2];
    if (url === undefined) continue;

    const attributes = `${tag[1] ?? ""} ${tag[3] ?? ""}`;
    if (/\bnomodule\b/i.test(attributes)) {
      legacyOnly.push(url);
    } else {
      modern.push(url);
    }
  }

  return { modern, legacyOnly };
}

/**
 * Turns the path of a prerendered document into the URL path it serves.
 *
 * The App Router writes its HTML at the route's own shape — route groups and
 * parallel-route slots are already resolved away by the time anything lands in
 * `.next/server/app`, so `(auth)/login/page.tsx` is written as `login.html`.
 * Interception markers are the exception and survive into the filename, which
 * is why `(.)photos/[id]` appears in the budget table looking like a route
 * group. It is a real, separately-bundled entry point.
 */
export function documentPathToPage(relativePath: string): string {
  const withoutExtension = relativePath
    .replace(/\\/g, "/")
    .replace(/\.html$/, "");
  return withoutExtension === "index" ? "/" : `/${withoutExtension}`;
}

/**
 * Matches a concrete page against the route pattern that produced it.
 *
 * Exact match first: `/photos` is its own route and must not be captured by
 * `/photos/[id]`. Then dynamic segments, with every literal part escaped —
 * `/(.)photos/[id]` contains regex metacharacters that are route syntax, and
 * treating them as a group and a wildcard would match `/aphotos/x`.
 */
export function matchRoute(
  page: string,
  routes: readonly string[],
): string | undefined {
  if (routes.includes(page)) return page;

  return routes.find((route) => {
    if (!route.includes("[")) return false;
    const pattern = route
      .split(/(\[\[?\.\.\.[^\]]+\]\]?|\[[^\]]+\])/)
      .map((part) => {
        if (/^\[\[?\.\.\./.test(part)) return ".+";
        if (/^\[[^\]]+\]$/.test(part)) return "[^/]+";
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    return new RegExp(`^${pattern}$`).test(page);
  });
}

/**
 * The chunks loaded by every page in the build.
 *
 * Intersection rather than "chunks loaded by more than N routes": the point of
 * this number is that it is unavoidable — a visitor pays it whichever page they
 * land on first. A chunk 25 of 26 routes load is a route-level cost that
 * happens to be widespread, and it belongs in those routes' budgets where a
 * change to it is attributed to them.
 */
export function sharedChunks(pages: readonly PagePayload[]): Chunk[] {
  const [first, ...rest] = pages;
  if (!first) return [];

  return first.modern.filter((chunk) =>
    rest.every((page) => page.modern.some((other) => other.url === chunk.url)),
  );
}

function totalGzip(chunks: readonly Chunk[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0);
}

function totalBytes(chunks: readonly Chunk[]): number {
  return chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
}

/**
 * Groups pages under their route and measures each against its budget.
 *
 * Returns a measurement for every budgeted route that produced at least one
 * page; routes that produced none are reported by `checkRouteCoverage`, which
 * is a different failure with a different cause.
 */
export function measureRoutes(
  pages: readonly PagePayload[],
  budgets: readonly RouteBudget[] = ROUTE_BUDGETS,
): RouteMeasurement[] {
  const shared = new Set(sharedChunks(pages).map((chunk) => chunk.url));
  const routes = budgets.map((budget) => budget.route);
  const measurements: RouteMeasurement[] = [];

  for (const budget of budgets) {
    const mine = pages.filter(
      (page) => matchRoute(page.page, routes) === budget.route,
    );
    if (mine.length === 0) continue;

    // The worst page is the one a visitor can land on and wait longest for, so
    // it is the one the budget applies to.
    const worst = mine.reduce((heaviest, page) =>
      totalGzip(page.modern) > totalGzip(heaviest.modern) ? page : heaviest,
    );

    const sharedPart = worst.modern.filter((chunk) => shared.has(chunk.url));

    measurements.push({
      route: budget.route,
      worstPage: worst.page,
      pages: mine.length,
      gzipBytes: totalGzip(worst.modern),
      bytes: totalBytes(worst.modern),
      sharedGzipBytes: totalGzip(sharedPart),
      ownGzipBytes: totalGzip(worst.modern) - totalGzip(sharedPart),
      gzipBudgetBytes: budget.gzipBudgetBytes,
      chunks: worst.modern.length,
      legacyGzipBytes: totalGzip(worst.legacyOnly),
    });
  }

  return measurements;
}

/** Fails a route whose worst page is over its ceiling. */
export function checkBudgets(
  measurements: readonly RouteMeasurement[],
  budgets: readonly RouteBudget[] = ROUTE_BUDGETS,
): Violation[] {
  const violations: Violation[] = [];

  for (const measurement of measurements) {
    if (measurement.gzipBytes <= measurement.gzipBudgetBytes) continue;
    const budget = budgets.find((b) => b.route === measurement.route);
    const over = measurement.gzipBytes - measurement.gzipBudgetBytes;

    violations.push({
      route: measurement.route,
      problem:
        `first-load JS is ${formatBytes(measurement.gzipBytes)} gzipped, ` +
        `${formatBytes(over)} over its ${formatBytes(measurement.gzipBudgetBytes)} budget ` +
        `(measured on ${measurement.worstPage}, ${measurement.chunks} chunks, ` +
        `${formatBytes(measurement.ownGzipBytes)} of it this route's own). ` +
        "Find what grew with `pnpm build` and compare the chunk list, or raise the budget " +
        "deliberately in ROUTE_BUDGETS and say why in the PR.",
      because: budget?.because ?? "budgeted in ROUTE_BUDGETS",
    });
  }

  return violations;
}

/** Fails when React and the router together outgrow their ceiling. */
export function checkSharedBaseline(
  pages: readonly PagePayload[],
  budgetBytes: number = SHARED_BASELINE_GZIP_BUDGET_BYTES,
): Violation[] {
  const shared = sharedChunks(pages);
  const gzipBytes = totalGzip(shared);
  if (gzipBytes <= budgetBytes) return [];

  return [
    {
      route: "(shared by every route)",
      problem:
        `the chunks every route loads are ${formatBytes(gzipBytes)} gzipped across ` +
        `${shared.length} chunk(s), ${formatBytes(gzipBytes - budgetBytes)} over the ` +
        `${formatBytes(budgetBytes)} baseline budget.`,
      because:
        "this is what a visitor downloads before any page of this application renders, " +
        "so it is the one number that is paid on every first visit",
    },
  ];
}

/**
 * Fails when the budget table and the build have drifted apart.
 *
 * Both directions matter and they fail for opposite reasons. A budgeted route
 * with no document has usually stopped prerendering — it went fully dynamic, or
 * it was renamed — and an unbudgeted document is a new route that would
 * otherwise ship with no ceiling at all, which is precisely the hole this gate
 * exists to close.
 */
export function checkRouteCoverage(
  pages: readonly PagePayload[],
  budgets: readonly RouteBudget[] = ROUTE_BUDGETS,
): Violation[] {
  const violations: Violation[] = [];
  const routes = budgets.map((budget) => budget.route);

  for (const budget of budgets) {
    const matched = pages.some(
      (page) => matchRoute(page.page, routes) === budget.route,
    );
    if (matched) continue;
    violations.push({
      route: budget.route,
      problem:
        "is budgeted but prerendered no document, so its payload could not be measured. " +
        "Either it stopped prerendering — a dynamic read moved above it — or the route was " +
        "renamed and this entry is stale.",
      because: budget.because,
    });
  }

  for (const page of pages) {
    if (matchRoute(page.page, routes)) continue;
    violations.push({
      route: page.page,
      problem:
        "prerendered a document but is in no budget, so it ships an unmeasured payload. " +
        "Add it to ROUTE_BUDGETS.",
      because: "every route that reaches a browser has a ceiling",
    });
  }

  return violations;
}

/** Fails when a document references a script that is not in the build. */
export function checkChunksExist(pages: readonly PagePayload[]): Violation[] {
  return pages
    .filter((page) => page.missing.length > 0)
    .map((page) => ({
      route: page.page,
      problem:
        `references ${page.missing.length} script(s) that are not in the build output: ` +
        `${page.missing.join(", ")}. The measurement below is missing their weight.`,
      because: "a payload measured from a partial build is not a measurement",
    }));
}

/**
 * Fails if Next's legacy polyfill bundle is served to modern browsers.
 *
 * It is 39 kB gzipped and it exists for browsers without ES modules, which is
 * why Next marks it `noModule`. Losing that attribute is a 39 kB regression on
 * every route at once that no per-route budget would attribute correctly —
 * they would all creep up together and each one would look like its own small
 * problem. The polyfill's filename is read from the build manifest rather than
 * guessed, so this keeps working when the hash changes.
 */
export function checkPolyfillIsLegacyOnly(
  pages: readonly PagePayload[],
  polyfillFiles: readonly string[],
): Violation[] {
  const polyfillUrls = new Set(polyfillFiles.map((file) => `/_next/${file}`));
  if (polyfillUrls.size === 0) return [];

  return pages
    .filter((page) => page.modern.some((chunk) => polyfillUrls.has(chunk.url)))
    .map((page) => ({
      route: page.page,
      problem:
        "loads Next's legacy polyfill bundle as a module script. It is emitted with " +
        "`noModule` so that only browsers without ES module support fetch it; without that " +
        "attribute every visitor downloads it, on this and every other route.",
      because:
        "the polyfill is excluded from these budgets precisely because modern browsers skip it",
    }));
}

export function checkBundleBudget(
  pages: readonly PagePayload[],
  polyfillFiles: readonly string[],
  budgets: readonly RouteBudget[] = ROUTE_BUDGETS,
  baselineBudgetBytes: number = SHARED_BASELINE_GZIP_BUDGET_BYTES,
): Violation[] {
  return [
    ...checkChunksExist(pages),
    ...checkRouteCoverage(pages, budgets),
    ...checkPolyfillIsLegacyOnly(pages, polyfillFiles),
    ...checkSharedBaseline(pages, baselineBudgetBytes),
    ...checkBudgets(measureRoutes(pages, budgets), budgets),
  ];
}

/**
 * kB as the web platform counts it — 1000 bytes, the same unit `next build`
 * and every browser devtools network panel use. Binary kibibytes would make
 * these numbers disagree with the tool a developer checks them against.
 */
export function formatBytes(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

/** The per-route payload report, as a fixed-width table. */
export function formatReport(
  measurements: readonly RouteMeasurement[],
  sharedGzipBytes: number,
  sharedChunkCount: number,
  legacyGzipBytes: number,
): string {
  const rows = [...measurements].sort((a, b) => b.gzipBytes - a.gzipBytes);
  const width = Math.max(24, ...rows.map((row) => row.route.length));
  const header =
    `${"Route".padEnd(width)}  ${"First load".padStart(10)}  ${"Own".padStart(9)}  ` +
    `${"Budget".padStart(10)}  ${"Headroom".padStart(10)}  Chunks`;

  const lines = rows.map((row) => {
    const headroom = row.gzipBudgetBytes - row.gzipBytes;
    const marker = headroom < 0 ? " OVER" : "";
    return (
      `${row.route.padEnd(width)}  ${formatBytes(row.gzipBytes).padStart(10)}  ` +
      `${formatBytes(row.ownGzipBytes).padStart(9)}  ` +
      `${formatBytes(row.gzipBudgetBytes).padStart(10)}  ` +
      `${formatBytes(headroom).padStart(10)}  ${String(row.chunks).padStart(6)}${marker}`
    );
  });

  return [
    header,
    "-".repeat(header.length),
    ...lines,
    "",
    `Shared by every route: ${formatBytes(sharedGzipBytes)} across ${sharedChunkCount} chunk(s) ` +
      `(budget ${formatBytes(SHARED_BASELINE_GZIP_BUDGET_BYTES)}) — React, React DOM and the App Router runtime.`,
    `Legacy polyfill bundle: ${formatBytes(legacyGzipBytes)}, \`noModule\`, not counted above.`,
    "All sizes are gzipped. 'Own' is first load minus the shared baseline.",
  ].join("\n");
}

/** The same report as Markdown, for GitHub's job summary panel. */
export function formatMarkdownReport(
  measurements: readonly RouteMeasurement[],
  sharedGzipBytes: number,
  sharedChunkCount: number,
): string {
  const rows = [...measurements].sort((a, b) => b.gzipBytes - a.gzipBytes);
  const body = rows.map((row) => {
    const headroom = row.gzipBudgetBytes - row.gzipBytes;
    const status = headroom < 0 ? "❌" : "✅";
    return (
      `| \`${row.route}\` | ${formatBytes(row.gzipBytes)} | ${formatBytes(row.ownGzipBytes)} | ` +
      `${formatBytes(row.gzipBudgetBytes)} | ${formatBytes(headroom)} | ${row.chunks} | ${status} |`
    );
  });

  return [
    "### Per-route JS payload",
    "",
    `Shared by every route: **${formatBytes(sharedGzipBytes)}** across ${sharedChunkCount} chunks ` +
      `(budget ${formatBytes(SHARED_BASELINE_GZIP_BUDGET_BYTES)}).`,
    "",
    "| Route | First load | Own | Budget | Headroom | Chunks | |",
    "| --- | ---: | ---: | ---: | ---: | ---: | :-: |",
    ...body,
    "",
    "All sizes gzipped, `noModule` polyfills excluded. " +
      "“Own” is first load minus the shared baseline.",
  ].join("\n");
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map(
      (v) =>
        `  ${v.route}\n    ${v.problem}\n    budgeted because: ${v.because}`,
    )
    .join("\n\n");
}

/**
 * Reads every prerendered document in the build and measures what it loads.
 *
 * `.next/server/app` is the only directory walked. The client build directory
 * holds every chunk the application can ever load, including those fetched on
 * navigation or behind a `dynamic()` boundary; summing it would measure the
 * application rather than any page of it, which is a number no visitor ever
 * waits for.
 */
export function readPagePayloads(nextDir: string): PagePayload[] {
  const appDir = path.join(nextDir, "server", "app");
  const documents: string[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".html")) {
        documents.push(full);
      }
    }
  };

  walk(appDir);

  if (documents.length === 0) {
    throw new Error(
      `No prerendered documents under ${appDir}. Run \`pnpm build\` before this gate — ` +
        "it reads the build output, not the source.",
    );
  }

  // Chunks are shared heavily between routes and gzipping a 300 kB file is not
  // free, so each one is measured once and reused across the ~26 documents
  // that reference it.
  const measured = new Map<string, Chunk | undefined>();
  const measure = (url: string): Chunk | undefined => {
    if (measured.has(url)) return measured.get(url);
    const onDisk = path.join(nextDir, url.replace(/^\/_next\//, ""));
    let chunk: Chunk | undefined;
    try {
      const contents = readFileSync(onDisk);
      chunk = {
        url,
        bytes: contents.byteLength,
        gzipBytes: gzipSync(contents, { level: 9 }).byteLength,
      };
    } catch {
      chunk = undefined;
    }
    measured.set(url, chunk);
    return chunk;
  };

  return documents.sort().map((file) => {
    const html = readFileSync(file, "utf8");
    const { modern, legacyOnly } = parseDocumentScripts(html);
    const missing: string[] = [];

    // A document can reference the same chunk from both a `<script>` and its
    // preload hint; a browser fetches it once and so does the budget.
    const collect = (urls: readonly string[]): Chunk[] => {
      const chunks: Chunk[] = [];
      for (const url of new Set(urls)) {
        const chunk = measure(url);
        if (chunk) chunks.push(chunk);
        else missing.push(url);
      }
      return chunks;
    };

    return {
      page: documentPathToPage(path.relative(appDir, file)),
      modern: collect(modern),
      legacyOnly: collect(legacyOnly),
      missing,
    };
  });
}

/**
 * The polyfill filenames the build recorded, so the `noModule` check does not
 * have to recognise the bundle by guessing at its name.
 */
export function readPolyfillFiles(nextDir: string): string[] {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(nextDir, "build-manifest.json"), "utf8"),
    ) as { polyfillFiles?: string[] };
    return manifest.polyfillFiles ?? [];
  } catch {
    return [];
  }
}

function main(argv: readonly string[]): number {
  const nextDir = argv[0] ?? ".next";
  const pages = readPagePayloads(nextDir);
  const polyfillFiles = readPolyfillFiles(nextDir);
  const violations = checkBundleBudget(pages, polyfillFiles);

  const measurements = measureRoutes(pages);
  const shared = sharedChunks(pages);
  const sharedGzip = totalGzip(shared);
  const legacyGzip = Math.max(
    0,
    ...measurements.map((measurement) => measurement.legacyGzipBytes),
  );

  const report = formatReport(
    measurements,
    sharedGzip,
    shared.length,
    legacyGzip,
  );
  console.log(report);

  writeReportArtifacts(nextDir, measurements, sharedGzip, shared.length);

  if (violations.length > 0) {
    console.error(
      `\nBundle budget exceeded — ${violations.length} problem(s):\n\n${formatViolations(violations)}\n`,
    );
    return 1;
  }

  console.log(
    `\nBundle budget OK — ${measurements.length} route(s) within budget, ` +
      `shared baseline ${formatBytes(sharedGzip)}.`,
  );
  return 0;
}

/* c8 ignore start -- I/O around the report; the logic above is what the tests exercise. */
function writeReportArtifacts(
  nextDir: string,
  measurements: readonly RouteMeasurement[],
  sharedGzipBytes: number,
  sharedChunkCount: number,
): void {
  const analyzeDir = path.join(nextDir, "analyze");
  try {
    mkdirSync(analyzeDir, { recursive: true });
    writeFileSync(
      path.join(analyzeDir, "bundle-budget.json"),
      `${JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          unit: "bytes, gzip level 9, noModule scripts excluded",
          shared: { gzipBytes: sharedGzipBytes, chunks: sharedChunkCount },
          routes: measurements,
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    // The report is a convenience; failing to write it must not fail a build
    // that is otherwise within budget.
  }

  // GitHub renders this under the job in the Actions UI, which is where a
  // reviewer looks — a number in a log nobody opens is not a report.
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  try {
    writeFileSync(
      summaryFile,
      `${formatMarkdownReport(measurements, sharedGzipBytes, sharedChunkCount)}\n`,
      { flag: "a" },
    );
  } catch {
    // Same reasoning.
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
/* c8 ignore stop */
