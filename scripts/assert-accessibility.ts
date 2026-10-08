/**
 * Asserts that every document this build prerendered is free of the WCAG 2.2 AA
 * violations axe-core can detect, in both themes.
 *
 * The gate reads the build output rather than driving a running server, for the
 * same reason every other gate in this repository does: the documents under
 * `.next/server/app` are what a visitor's browser receives first, they exist
 * for routes no unauthenticated request could ever reach (`/admin`,
 * `/settings/security`), and they are the same bytes on every run. A server
 * would also answer `/dashboard` with a redirect to `/login`, so the audit
 * would quietly cover thirteen routes instead of thirty-one.
 *
 * It is a real browser and not jsdom, and that is the whole difference between
 * this gate and a decorative one. The first version of it ran axe in jsdom and
 * reported zero violations across the application — because jsdom performs no
 * layout, so `color-contrast` and `target-size`, between them most of what AA
 * adds over A, came back `incomplete` on every page and were silently not
 * checked. Chromium with the build's own stylesheet attached evaluates both.
 *
 * Two deliberate restrictions on what it looks at:
 *
 *   - External scripts are blocked, so nothing hydrates. The document is
 *     audited as served, which is the state a visitor reads on a slow
 *     connection and the only state that is identical on every run. Inline
 *     scripts still run — the theme script among them, which is how the themes
 *     below are applied by the application's own mechanism rather than by this
 *     file's imitation of one.
 *   - One desktop viewport. `target-size` is a touch criterion and a narrow
 *     viewport is where it bites; that pass belongs with the interactive suite,
 *     which has a device matrix. See `docs/accessibility.md`.
 *
 * Both themes are audited because the dark palette is a separate set of
 * colours that no light-mode run can speak for. The first run of this gate
 * found `--primary` at 4.37:1 on the dark background — below AA for 14px text —
 * on `/login` and `/register`, where it had been since the palette was written.
 * `--primary` had no `.dark` override at all.
 *
 * Usage: tsx scripts/assert-accessibility.ts [path-to-.next]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import axe from "axe-core";
import { chromium } from "@playwright/test";

/**
 * The rule sets axe runs. WCAG 2.2 AA is the target, so every level-A and
 * level-AA tag up to 2.2 is in scope and nothing else is — `best-practice`
 * rules are deliberately excluded, because a gate that fails on advice nobody
 * agreed to is a gate people start passing with `--no-verify`.
 */
export const WCAG_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
] as const;

export type Theme = "light" | "dark";

/** Both themes, in the order the report prints them. */
export const THEMES: readonly Theme[] = ["light", "dark"];

/** A document in the build output, and the path the audit serves it at. */
export interface AuditTarget {
  /** URL path, derived from the file's position under `.next/server/app`. */
  route: string;
  /** Absolute path to the prerendered `.html`. */
  file: string;
}

/** The parts of an axe node this gate reads. */
export interface AxeNode {
  target: readonly string[];
  html: string;
  failureSummary?: string;
}

/** The parts of an axe result this gate reads. */
export interface AxeResult {
  id: string;
  impact: string | null;
  help: string;
  nodes: readonly AxeNode[];
}

export interface AxeRun {
  violations: readonly AxeResult[];
  incomplete: readonly AxeResult[];
  /** Rules that ran and found nothing wrong — the gate's non-vacuity evidence. */
  passes: readonly { id: string }[];
}

/**
 * What the browser could see of the application's own CSS.
 *
 * This exists because of a specific wrong green. An earlier version of the
 * runner blocked `**\/_next/static/chunks/**` to stop React hydrating, and the
 * build puts the stylesheet in `chunks/` too — so the audit ran against
 * unstyled markup, where `color-contrast` is either inapplicable or trivially
 * satisfied by black on white. It reported no violations on pages that have
 * since been shown to have them. Nothing in an axe result says "I was looking
 * at the wrong document", so the gate has to ask separately.
 */
export interface DocumentStyling {
  /** Rules parsed from the build's stylesheet. Zero means it never arrived. */
  stylesheetRules: number;
  /** `getComputedStyle(body).backgroundColor`. Transparent means `--background` did not resolve. */
  bodyBackgroundColor: string;
  /** Whether the application's own theme script put the audited theme on `<html>`. */
  themeClassApplied: boolean;
}

export interface DocumentAudit {
  route: string;
  theme: Theme;
  run: AxeRun;
  styling: DocumentStyling;
}

export type AxeRunner = (
  target: AuditTarget,
  theme: Theme,
) => Promise<DocumentAudit>;

/**
 * A finding the gate accepts, with the reason written down.
 *
 * Narrow by construction: a rule plus the route it applies to, and optionally
 * the markup of the node it applies to, so an exemption for one element cannot
 * cover the next regression in the same rule on the same page. An allowance
 * that matches nothing is itself a failure — see `staleAllowances`.
 */
export interface Allowance {
  /** Exact route, or a pattern for a family of them (seeded content). */
  route: string | RegExp;
  /** axe rule id. */
  rule: string;
  /** Restricts this to one theme. Omitted means either. */
  theme?: Theme;
  /** Substring the offending node's markup must contain. */
  htmlIncludes?: string;
  /** Why this is acceptable. Printed when the allowance goes stale. */
  because: string;
}

/**
 * Violations the gate accepts.
 *
 * Both are the same fact about Next's fallback shells: the document a dynamic
 * segment prerenders for a parameter it has not seen is rendered before the
 * parameter exists, so a `generateMetadata` that reads the parameter cannot
 * have produced a `<title>` yet — Next streams it in with the rest of the
 * response. The concrete paths prerendered from real rows (`/blog/seed-post-…`,
 * `/photos/ocean-at-sunset`) all carry their titles and are audited here like
 * any other document, which is what keeps this from being an exemption for the
 * whole rule.
 */
export const ALLOWED_VIOLATIONS: readonly Allowance[] = [
  {
    // The one allowance here that is not about fallback shells, and the one
    // that cannot be fixed from this repository. `_global-error.html` is Next's
    // own static 500 document — the bytes it serves when the server cannot
    // render at all — and it is emitted whether or not the application defines
    // `global-error.tsx`: a clean build with `src/app/global-error.tsx` in place
    // writes this same `<html id="__next_error__">`, with no `lang`, and none of
    // that component's markup. `global-error.tsx` governs the runtime boundary
    // instead, and does carry `lang="en"` — see its own tests.
    //
    // Pinned to Next's markup by `htmlIncludes`, so a document of ours that
    // loses its `lang` still fails this rule on this route.
    route: "/_global-error",
    rule: "html-has-lang",
    htmlIncludes: 'id="__next_error__"',
    because:
      "Next generates this static 500 document itself and gives its `<html>` no `lang`; `global-error.tsx` cannot replace it, only the runtime boundary it is the fallback for",
  },
  {
    route: "/blog/[slug]",
    rule: "document-title",
    because:
      "the fallback shell for an unseen slug is prerendered before the slug exists, so `generateMetadata` has not run; Next streams the title into the real response",
  },
  {
    route: "/photos/[id]",
    rule: "document-title",
    because:
      "the same fallback-shell property as /blog/[slug]: the title is derived from the photo this document does not yet know",
  },
];

/**
 * Indeterminate results the gate accepts.
 *
 * `incomplete` is treated as a failure by default and that is the deliberate
 * choice: "axe could not decide" is precisely where a regression hides. The
 * wrong green described on `DocumentStyling` presented as twenty-two
 * `incomplete` colour-contrast results and zero violations.
 */
export const ALLOWED_INCOMPLETE: readonly Allowance[] = [
  {
    route: "/posts/[id]",
    rule: "bypass",
    because:
      "this fallback shell has no landmark yet: `NavLinks` calls `usePathname`, which a document prerendered for an unknown id cannot answer, so the whole nav subtree streams — the same property `assert-streaming-boundaries.ts` asserts for this route",
  },
  {
    // Seeded slugs rather than a fixed list: `prisma/seed.ts` owns the titles,
    // and a gate that named them would fail the next time the seed changed.
    route: /^\/blog\/(?!\[)/,
    rule: "color-contrast",
    htmlIncludes: "bg-gradient-to-t",
    because:
      "the video facade's caption sits on `from-black/80 to-transparent` over a thumbnail, and axe reports a gradient as undecidable rather than measuring it. Reviewed by hand: the text box is `pb-3` from the bottom, inside the region that is at least 80% black, which is 12.6:1 against white even over the lightest possible frame",
  },
];

/**
 * Documents that must be in the build output.
 *
 * The audit itself covers whatever it finds, so a new route is in scope the
 * moment it prerenders and nobody has to remember this list. The list is for
 * the other direction: a route that stops prerendering — one cookie read in the
 * wrong place does it — leaves the audit silently smaller and still green.
 * `assert-route-shape.ts` is the gate that explains why a route went dynamic;
 * this one only insists that the a11y coverage noticed.
 *
 * Seed-derived paths are deliberately absent: they come and go with
 * `prisma/seed.ts` and are audited without being required.
 */
export const REQUIRED_DOCUMENTS: readonly string[] = [
  "/",
  "/_global-error",
  "/_not-found",
  "/(.)photos/[id]",
  "/admin",
  "/blog",
  "/blog/[slug]",
  "/dashboard",
  "/forbidden",
  "/images",
  "/login",
  "/photos",
  "/photos/[id]",
  "/posts",
  "/posts/[id]",
  "/pricing",
  "/pricing/v/[variant]",
  "/register",
  "/settings/security",
  "/upload",
];

/**
 * Rules that must have been evaluated somewhere in each theme.
 *
 * The two that need a laid-out, styled page — which is to say the two a jsdom
 * run or an unstyled one loses without saying so. Asserted across the run
 * rather than per document, because a shell that streams all of its text has
 * nothing for either rule to look at and is not broken for that.
 */
export const RULES_THAT_MUST_RUN = ["color-contrast", "target-size"] as const;

/**
 * Documents that legitimately carry no theme class.
 *
 * `global-error.tsx` replaces the root layout, so the provider that writes
 * `.light`/`.dark` onto `<html>` is not in that document at all — it follows
 * `prefers-color-scheme` instead, which the runner sets alongside the stored
 * theme, so its dark pass is a real dark pass by the other mechanism.
 *
 * Listed rather than inferred, and checked in both directions: a document here
 * that turns out to have the class is reported as a stale entry, the same way
 * an unused allowance is.
 */
export const DOCUMENTS_WITHOUT_THEME_CLASS: readonly string[] = [
  "/_global-error",
];

export interface Finding {
  route: string;
  theme: Theme;
  rule: string;
  impact: string | null;
  help: string;
  /** `violation` or `incomplete` — the two axe outcomes this gate fails on. */
  kind: "violation" | "incomplete";
  nodes: readonly AxeNode[];
}

export interface Report {
  findings: readonly Finding[];
  /** Allowances that matched nothing, so no longer describe the application. */
  staleAllowances: readonly Allowance[];
  /** Required routes with no prerendered document. */
  missingDocuments: readonly string[];
  /** Documents where the browser never got the application's CSS. */
  unstyled: readonly { route: string; theme: Theme; problem: string }[];
  /** `RULES_THAT_MUST_RUN` entries that were never evaluated, per theme. */
  rulesThatDidNotRun: readonly { theme: Theme; rule: string }[];
  /**
   * Routes listed in `DOCUMENTS_WITHOUT_THEME_CLASS` that do carry the class.
   * The entry is no longer true, so it should go rather than stay as a hole.
   */
  themedDespiteExemption: readonly string[];
  /** How many (document, theme) pairs were audited. */
  audited: number;
}

/** Every prerendered document under `.next/server/app`, in a stable order. */
export function discoverDocuments(appDir: string): AuditTarget[] {
  const found: AuditTarget[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const absolute = path.join(dir, entry);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.endsWith(".html")) continue;
      found.push({ route: routeForFile(appDir, absolute), file: absolute });
    }
  };

  if (existsSync(appDir)) walk(appDir);
  return found.sort((a, b) => a.route.localeCompare(b.route));
}

/** `…/app/blog/[slug].html` → `/blog/[slug]`, `…/app/index.html` → `/`. */
export function routeForFile(appDir: string, file: string): string {
  const relative = path
    .relative(appDir, file)
    .replace(/\.html$/, "")
    .split(path.sep)
    .join("/");
  return relative === "index" ? "/" : `/${relative}`;
}

export function missingDocuments(
  found: readonly AuditTarget[],
  required: readonly string[] = REQUIRED_DOCUMENTS,
): string[] {
  const routes = new Set(found.map((target) => target.route));
  return required.filter((route) => !routes.has(route));
}

function matchesRoute(allowance: Allowance, route: string): boolean {
  return typeof allowance.route === "string"
    ? allowance.route === route
    : allowance.route.test(route);
}

/**
 * Whether `allowance` covers this result on this document.
 *
 * A result is covered only if *every* node it reports is covered, so an
 * exemption written for one element does not absorb a second element that
 * tripped the same rule on the same page.
 */
export function covers(
  allowance: Allowance,
  route: string,
  theme: Theme,
  result: AxeResult,
): boolean {
  if (allowance.rule !== result.id) return false;
  if (!matchesRoute(allowance, route)) return false;
  if (allowance.theme !== undefined && allowance.theme !== theme) return false;

  const needle = allowance.htmlIncludes;
  if (needle === undefined) return true;
  return result.nodes.every((node) => node.html.includes(needle));
}

function problemsWithStyling(
  route: string,
  styling: DocumentStyling,
  withoutThemeClass: readonly string[],
): string[] {
  const problems: string[] = [];

  if (styling.stylesheetRules === 0) {
    problems.push(
      "the browser parsed no CSS rules — the build's stylesheet never arrived, which turns every colour and size rule into a result about unstyled markup",
    );
  }

  // `transparent` and `rgba(…, 0)` both mean `--background` did not resolve.
  if (
    /^(transparent|rgba\([^)]*,\s*0\s*\))$/.test(styling.bodyBackgroundColor)
  ) {
    problems.push(
      `\`body\` has no resolved background (${styling.bodyBackgroundColor}), so axe has nothing to measure foreground colours against`,
    );
  }

  const expectThemeClass = !withoutThemeClass.includes(route);
  if (expectThemeClass && !styling.themeClassApplied) {
    problems.push(
      "the theme class is not on `<html>` — the application's inline theme script did not run, so this is not the theme the gate thinks it audited",
    );
  }

  return problems;
}

/**
 * Turns the audits into a report. Pure, and takes the allowance tables as
 * arguments, so the tests can describe a regression without running a build.
 */
export function buildReport(
  audits: readonly DocumentAudit[],
  found: readonly AuditTarget[],
  options: {
    allowedViolations?: readonly Allowance[];
    allowedIncomplete?: readonly Allowance[];
    required?: readonly string[];
    themes?: readonly Theme[];
    rulesThatMustRun?: readonly string[];
    withoutThemeClass?: readonly string[];
  } = {},
): Report {
  const allowedViolations = options.allowedViolations ?? ALLOWED_VIOLATIONS;
  const allowedIncomplete = options.allowedIncomplete ?? ALLOWED_INCOMPLETE;
  const themes = options.themes ?? THEMES;
  const rulesThatMustRun = options.rulesThatMustRun ?? RULES_THAT_MUST_RUN;
  const withoutThemeClass =
    options.withoutThemeClass ?? DOCUMENTS_WITHOUT_THEME_CLASS;

  const findings: Finding[] = [];
  const used = new Set<Allowance>();
  const unstyled: { route: string; theme: Theme; problem: string }[] = [];
  const evaluated = new Map<Theme, Set<string>>(
    themes.map((theme) => [theme, new Set<string>()]),
  );

  const themedAnyway = new Set<string>();

  for (const audit of audits) {
    for (const problem of problemsWithStyling(
      audit.route,
      audit.styling,
      withoutThemeClass,
    )) {
      unstyled.push({ route: audit.route, theme: audit.theme, problem });
    }

    if (
      withoutThemeClass.includes(audit.route) &&
      audit.styling.themeClassApplied
    ) {
      themedAnyway.add(audit.route);
    }

    const seen = evaluated.get(audit.theme);
    if (seen) {
      for (const result of [
        ...audit.run.passes,
        ...audit.run.violations,
        ...audit.run.incomplete,
      ]) {
        seen.add(result.id);
      }
    }

    const buckets = [
      {
        kind: "violation" as const,
        results: audit.run.violations,
        allowances: allowedViolations,
      },
      {
        kind: "incomplete" as const,
        results: audit.run.incomplete,
        allowances: allowedIncomplete,
      },
    ];

    for (const { kind, results, allowances } of buckets) {
      for (const result of results) {
        const allowance = allowances.find((candidate) =>
          covers(candidate, audit.route, audit.theme, result),
        );
        if (allowance) {
          used.add(allowance);
          continue;
        }
        findings.push({
          route: audit.route,
          theme: audit.theme,
          rule: result.id,
          impact: result.impact,
          help: result.help,
          kind,
          nodes: result.nodes,
        });
      }
    }
  }

  const rulesThatDidNotRun: { theme: Theme; rule: string }[] = [];
  for (const theme of themes) {
    const seen = evaluated.get(theme) ?? new Set<string>();
    for (const rule of rulesThatMustRun) {
      if (!seen.has(rule)) rulesThatDidNotRun.push({ theme, rule });
    }
  }

  return {
    findings,
    staleAllowances: [...allowedViolations, ...allowedIncomplete].filter(
      (allowance) => !used.has(allowance),
    ),
    missingDocuments: missingDocuments(found, options.required),
    unstyled,
    rulesThatDidNotRun,
    themedDespiteExemption: [...themedAnyway].sort(),
    audited: audits.length,
  };
}

export function reportIsClean(report: Report): boolean {
  return (
    report.findings.length === 0 &&
    report.staleAllowances.length === 0 &&
    report.missingDocuments.length === 0 &&
    report.unstyled.length === 0 &&
    report.rulesThatDidNotRun.length === 0 &&
    report.themedDespiteExemption.length === 0
  );
}

function describeAllowance(allowance: Allowance): string {
  const route =
    typeof allowance.route === "string"
      ? allowance.route
      : String(allowance.route);
  const theme = allowance.theme ? ` (${allowance.theme})` : "";
  return `${allowance.rule} on ${route}${theme}`;
}

export function formatReport(report: Report): string {
  const sections: string[] = [];

  if (report.findings.length > 0) {
    sections.push(
      report.findings
        .map((finding) => {
          const nodes = finding.nodes
            .slice(0, 4)
            .map(
              (node) =>
                `      ${node.target.join(" ")}\n` +
                `        ${node.html.replace(/\s+/g, " ").slice(0, 160)}` +
                (node.failureSummary
                  ? `\n        ${node.failureSummary.replace(/\s*\n\s*/g, " / ")}`
                  : ""),
            )
            .join("\n");
          const more =
            finding.nodes.length > 4
              ? `\n      … and ${finding.nodes.length - 4} more node(s)`
              : "";
          return (
            `  ${finding.route} [${finding.theme}] ${finding.rule} ` +
            `(${finding.kind}${finding.impact ? `, ${finding.impact}` : ""})\n` +
            `    ${finding.help}\n${nodes}${more}`
          );
        })
        .join("\n\n"),
    );
  }

  if (report.unstyled.length > 0) {
    sections.push(
      "  The audit did not see the application as it is served:\n" +
        report.unstyled
          .map((u) => `    ${u.route} [${u.theme}] — ${u.problem}`)
          .join("\n"),
    );
  }

  if (report.rulesThatDidNotRun.length > 0) {
    sections.push(
      "  Rules that must be evaluated somewhere never ran, so this run proves\n" +
        "  less than it appears to:\n" +
        report.rulesThatDidNotRun
          .map(
            (r) => `    ${r.rule} was never evaluated in the ${r.theme} theme`,
          )
          .join("\n"),
    );
  }

  if (report.missingDocuments.length > 0) {
    sections.push(
      "  Required routes prerendered no document, so the audit no longer covers\n" +
        "  them (see scripts/assert-route-shape.ts for why a route goes dynamic):\n" +
        report.missingDocuments.map((route) => `    ${route}`).join("\n"),
    );
  }

  if (report.themedDespiteExemption.length > 0) {
    sections.push(
      "  These documents are listed as carrying no theme class, and do carry it.\n" +
        "  Remove them from DOCUMENTS_WITHOUT_THEME_CLASS so the check applies:\n" +
        report.themedDespiteExemption.map((route) => `    ${route}`).join("\n"),
    );
  }

  if (report.staleAllowances.length > 0) {
    sections.push(
      "  Allowances that matched nothing. Either the markup they describe is\n" +
        "  gone — delete them, they are hiding the next regression — or the audit\n" +
        "  stopped reaching the document they are written for:\n" +
        report.staleAllowances
          .map(
            (a) =>
              `    ${describeAllowance(a)}\n      was allowed because ${a.because}`,
          )
          .join("\n"),
    );
  }

  return sections.join("\n\n");
}

/** Media types the asset server needs. Anything else is served as bytes. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Serves the build output: documents by route, and `/_next/static/**` from the
 * directory the build wrote.
 *
 * The stylesheet is the only asset that has to arrive — `/_next/image` is a
 * server route this has no equivalent of, so photographs 404 and render as
 * empty boxes with their `alt` text intact, which is what `image-alt` reads.
 */
export function createAssetServer(nextDir: string): {
  server: Server;
  listen: () => Promise<string>;
} {
  const appDir = path.resolve(nextDir, "server", "app");
  const staticDir = path.resolve(nextDir, "static");
  const STATIC_PREFIX = "/_next/static/";

  const serveFile = (
    root: string,
    requested: string,
    res: ServerResponse,
  ): boolean => {
    const absolute = path.resolve(root, requested);
    // Nothing outside the build output, however the path is spelled.
    if (absolute !== root && !absolute.startsWith(root + path.sep))
      return false;
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return false;

    const type =
      CONTENT_TYPES[path.extname(absolute).toLowerCase()] ??
      "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(readFileSync(absolute));
    return true;
  };

  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(
      new URL(req.url ?? "/", "http://audit.invalid").pathname,
    );

    if (pathname.startsWith(STATIC_PREFIX)) {
      if (serveFile(staticDir, pathname.slice(STATIC_PREFIX.length), res))
        return;
      res.writeHead(404).end();
      return;
    }

    const document =
      pathname === "/" ? "index.html" : `${pathname.slice(1)}.html`;
    if (serveFile(appDir, document, res)) return;

    // A document the audit asked for and the build did not write is a bug in
    // the discovery above, not a page to audit — so this body is deliberately
    // not a valid one, and the gate fails on it rather than skipping it.
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<!doctype html><html><body>no such document");
  });

  return {
    server,
    listen: () =>
      new Promise<string>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("asset server did not bind a TCP port"));
            return;
          }
          resolve(`http://127.0.0.1:${address.port}`);
        });
      }),
  };
}

/**
 * The key `next-themes` persists the choice under. Its default, spelled out
 * here because this gate depends on it; `themeClassApplied` is the check that
 * fails if it ever changes.
 */
export const THEME_STORAGE_KEY = "theme";

/**
 * The real runner: Chromium over the asset server, with axe injected.
 *
 * `localStorage` is seeded before navigation and the theme is then applied by
 * the application's own inline script, not by this file. `themeClassApplied`
 * is what makes that trustworthy — if `next-themes` ever stops reading that
 * key, the dark pass becomes a second light pass, and only an assertion about
 * `<html>` notices.
 */
export async function createChromiumRunner(nextDir: string): Promise<{
  run: AxeRunner;
  close: () => Promise<void>;
}> {
  const { server, listen } = createAssetServer(nextDir);
  const origin = await listen();
  // CI installs the Chromium build pinned by `@playwright/test`, which is the
  // default and needs no path. `A11Y_CHROMIUM_PATH` is for a sandbox that
  // cannot reach `cdn.playwright.dev` and already has a Chromium on disk: the
  // audit's conclusions are about the markup and the stylesheet, so a browser
  // a few builds either side of the pinned one is an honest substitute, and
  // having to skip the gate entirely is not.
  const executablePath = process.env["A11Y_CHROMIUM_PATH"];
  const browser = await chromium.launch(
    executablePath === undefined || executablePath === ""
      ? {}
      : { executablePath },
  );

  const run: AxeRunner = async (target, theme) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: theme,
    });
    try {
      await context.addInitScript(
        ({ key, value }: { key: string; value: string }) => {
          try {
            window.localStorage.setItem(key, value);
          } catch {
            // A storage-less context would make the theme assertion below fail
            // loudly, which is the right place to report it.
          }
        },
        { key: THEME_STORAGE_KEY, value: theme },
      );

      const page = await context.newPage();
      // Nothing hydrates: see the restrictions at the top of this file.
      await page.route("**/*", (route) =>
        route.request().resourceType() === "script"
          ? route.abort()
          : route.continue(),
      );

      const response = await page.goto(`${origin}${encodeURI(target.route)}`, {
        waitUntil: "load",
      });
      if (response === null || !response.ok()) {
        throw new Error(
          `${target.route}: asset server answered ${response?.status() ?? "nothing"}`,
        );
      }

      const styling = await page.evaluate((expected) => {
        let stylesheetRules = 0;
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            stylesheetRules += sheet.cssRules.length;
          } catch {
            // A cross-origin sheet cannot be counted; there are none here.
          }
        }
        return {
          stylesheetRules,
          bodyBackgroundColor: getComputedStyle(document.body).backgroundColor,
          themeClassApplied: document.documentElement.classList.contains(
            expected as string,
          ),
        };
      }, theme);

      await page.addScriptTag({ content: axe.source });
      const result = (await page.evaluate(
        (tags) =>
          (
            window as unknown as {
              axe: {
                run: (context: Document, options: unknown) => Promise<AxeRun>;
              };
            }
          ).axe.run(document, {
            runOnly: { type: "tag", values: tags },
            resultTypes: ["violations", "incomplete"],
          }),
        [...WCAG_TAGS],
      )) as AxeRun;

      return { route: target.route, theme, run: result, styling };
    } finally {
      await context.close();
    }
  };

  return {
    run,
    close: async () => {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function auditDocuments(
  run: AxeRunner,
  targets: readonly AuditTarget[],
  themes: readonly Theme[] = THEMES,
): Promise<DocumentAudit[]> {
  const audits: DocumentAudit[] = [];
  for (const theme of themes) {
    for (const target of targets) {
      audits.push(await run(target, theme));
    }
  }
  return audits;
}

async function main(argv: readonly string[]): Promise<number> {
  const nextDir = path.resolve(argv[0] ?? ".next");
  const targets = discoverDocuments(path.join(nextDir, "server", "app"));

  if (targets.length === 0) {
    console.error(
      `No prerendered documents under ${path.join(nextDir, "server", "app")} — run \`pnpm build\` first.`,
    );
    return 1;
  }

  const { run, close } = await createChromiumRunner(nextDir);
  let report: Report;
  try {
    report = buildReport(await auditDocuments(run, targets), targets);
  } finally {
    await close();
  }

  if (!reportIsClean(report)) {
    console.error(
      `WCAG 2.2 AA audit failed — ${report.findings.length} finding(s) across ` +
        `${report.audited} document/theme pair(s):\n\n${formatReport(report)}\n`,
    );
    return 1;
  }

  console.log(
    `WCAG 2.2 AA audit OK — ${targets.length} prerendered document(s) × ` +
      `${THEMES.length} theme(s), ${WCAG_TAGS.length} rule set(s), no violations.`,
  );
  return 0;
}

/* c8 ignore start -- CLI entry; the logic above is what the tests exercise. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
/* c8 ignore stop */
