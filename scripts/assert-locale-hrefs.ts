/**
 * Asserts that every href written in this repository names a route that exists.
 *
 * ## Why this gate exists
 *
 * `typedRoutes: true` used to answer this question. It cannot any more, and the
 * reason is `localePrefix: "as-needed"` rather than anything about the links
 * themselves. With the tree under `src/app/[locale]`, `next typegen` derives its
 * `Route` type from the segment paths — `/[locale]/posts/[id]` — while the URL
 * the default locale is actually served at is `/posts/1`. `next-intl` redirects
 * `/en/posts/1` away, because the point of `as-needed` is that the default
 * locale has one canonical URL. So the generated type describes the segment tree
 * and `@/i18n/navigation`'s `Link` takes the public path, and nothing can be
 * both: its `href` is `string`.
 *
 * That is a check this repository paid for and lost, so this is the replacement.
 * It reads every href literal out of the sources and resolves it against the
 * route tree on disk, which covers what `typedRoutes` covered for these call
 * sites — a link to a page that does not exist — and adds one thing it never
 * did: whether the href was written against the public paths or against the
 * segment tree. `<Link href="/en/posts">` type-checks under any scheme and is
 * wrong under this one.
 *
 * ## What it reads
 *
 * String and template-literal `href` attributes in `src/app` and
 * `src/components`, plus the `href` properties of object literals (which is how
 * `src/components/nav/nav-items.ts` holds the navigation). A non-literal href —
 * a variable, a call — is counted and skipped: this gate cannot resolve one, and
 * reporting it would be a finding about the shape of the code rather than about
 * a route. `R3` below is what stops that exemption growing silently.
 *
 * A template literal becomes a pattern: `` `/posts/${post.id}` `` is
 * `/posts/<dynamic>`, which matches the `[id]` segment and nothing else. That is
 * the same resolution the router performs, so an interpolation in the wrong
 * position fails here.
 *
 * Usage: tsx scripts/assert-locale-hrefs.ts [repo-root]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { LOCALES } from "../src/i18n/locales.js";

/** The root of the localised route tree. */
export const APP_SEGMENT_ROOT = "src/app/[locale]";

/** Directories whose hrefs this gate reads. */
export const SOURCE_ROOTS = ["src/app", "src/components"] as const;

/** Stands in for an interpolation, and for a `[param]` segment. */
const DYNAMIC = "<dynamic>";

export interface Finding {
  file: string;
  rule: "R1" | "R2" | "R3";
  message: string;
}

export interface HrefSite {
  file: string;
  /** The href as written, for the message. */
  raw: string;
  /** The href with interpolations replaced by `<dynamic>`, or `null` if unresolvable. */
  pattern: string | null;
}

// ---------------------------------------------------------------------------
// The route tree
// ---------------------------------------------------------------------------

/**
 * Every public path `src/app/[locale]` can answer, as a pattern.
 *
 * Route groups (`(auth)`), parallel slots (`@modal`), private folders
 * (`_components`) and interception markers (`(.)photos`) contribute no segment
 * to a URL, which is the whole reason a reader cannot do this by looking at the
 * paths. `[param]` becomes `<dynamic>`; a catch-all becomes `<dynamic>` too,
 * which makes this gate accept a shorter path than a catch-all would — the
 * permissive direction, and the one that cannot fail a correct link.
 */
export function routePatterns(root: string): Set<string> {
  const patterns = new Set<string>();
  const base = path.join(root, APP_SEGMENT_ROOT);
  if (!existsSync(base)) return patterns;

  const walk = (directory: string, segments: string[]): void => {
    const entries = readdirSync(directory, { withFileTypes: true });

    if (entries.some((entry) => /^page\.tsx?$/u.test(entry.name))) {
      patterns.add(segments.length === 0 ? "/" : `/${segments.join("/")}`);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const { name } = entry;

      // Contributes no URL segment.
      if (name.startsWith("_")) continue;
      if (name.startsWith("@")) continue;
      if (name.startsWith("(")) {
        walk(path.join(directory, name), segments);
        continue;
      }

      const segment = /^\[.+\]$/u.test(name) ? DYNAMIC : name;
      walk(path.join(directory, name), [...segments, segment]);
    }
  };

  walk(base, []);
  return patterns;
}

/** Whether `pattern` resolves to one of the routes on disk. */
export function resolves(pattern: string, patterns: Set<string>): boolean {
  if (patterns.has(pattern)) return true;

  const wanted = pattern.split("/");
  for (const candidate of patterns) {
    const parts = candidate.split("/");
    if (parts.length !== wanted.length) continue;
    const matches = parts.every(
      (part, index) => part === DYNAMIC || part === wanted[index],
    );
    if (matches) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Reading the hrefs
// ---------------------------------------------------------------------------

/** Source files whose hrefs are in scope. */
export function sourceFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (relative: string): void => {
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) return;

    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const next = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(next);
      } else if (
        /\.tsx?$/u.test(entry.name) &&
        !/\.test\.tsx?$/u.test(entry.name)
      ) {
        found.push(next);
      }
    }
  };

  for (const directory of SOURCE_ROOTS) walk(directory);
  return found;
}

/** The pattern a template literal describes, with interpolations blanked. */
function templatePattern(node: ts.TemplateExpression): string {
  const parts = [node.head.text];
  for (const span of node.templateSpans) {
    parts.push(DYNAMIC, span.literal.text);
  }
  return parts.join("");
}

/**
 * Every href literal in one file.
 *
 * Both spellings are read: the JSX attribute, and the `href` property of an
 * object literal. The second is not a stylistic alternative — it is how the
 * navigation is declared, and a gate that only read JSX would have had nothing
 * to say about the six links in the sidebar.
 */
export function hrefsIn(file: string, text: string): HrefSite[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const sites: HrefSite[] = [];

  const record = (initializer: ts.Node | undefined, raw: string): void => {
    if (initializer === undefined) return;

    if (ts.isStringLiteral(initializer)) {
      sites.push({ file, raw: initializer.text, pattern: initializer.text });
      return;
    }
    if (ts.isNoSubstitutionTemplateLiteral(initializer)) {
      sites.push({ file, raw: initializer.text, pattern: initializer.text });
      return;
    }
    if (ts.isTemplateExpression(initializer)) {
      sites.push({
        file,
        raw: raw,
        pattern: templatePattern(initializer),
      });
      return;
    }
    sites.push({ file, raw, pattern: null });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "href") {
      const { initializer } = node;
      if (initializer === undefined) {
        sites.push({ file, raw: "href", pattern: null });
      } else if (ts.isJsxExpression(initializer)) {
        record(initializer.expression, initializer.getText(source));
      } else {
        record(initializer, initializer.getText(source));
      }
    }

    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === "href"
    ) {
      record(node.initializer, node.initializer.getText(source));
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return sites;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** Hrefs this gate has nothing to say about: off-site, in-page, or a protocol. */
function isOutOfScope(pattern: string): boolean {
  if (pattern === "") return true;
  if (pattern.startsWith("#")) return true;
  if (pattern.startsWith("//")) return true;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(pattern)) return true;
  return !pattern.startsWith("/");
}

/** The path part of an href, without its query string or fragment. */
export function hrefPath(pattern: string): string {
  const cut = pattern.search(/[?#]/u);
  const withoutSearch = cut === -1 ? pattern : pattern.slice(0, cut);
  if (withoutSearch.length > 1 && withoutSearch.endsWith("/")) {
    return withoutSearch.slice(0, -1);
  }
  return withoutSearch;
}

export interface CheckOptions {
  /** Relative paths whose non-literal hrefs are accepted. See R3. */
  readonly unresolvableAllowed?: readonly string[];
}

/**
 * `src/app/api` is out of scope, and so is `global-error.tsx`.
 *
 * Route handlers render no links. `global-error.tsx` sits above the `[locale]`
 * segment and its one link is to `/`, which resolves in every locale — but it
 * cannot use `@/i18n/navigation`, because it renders outside the provider that
 * supplies the locale. Excluding it keeps this gate's subject "links that go
 * through the locale-aware wrappers".
 */
function inScope(file: string): boolean {
  if (file.startsWith("src/app/api/")) return false;
  if (file === "src/app/global-error.tsx") return false;
  return true;
}

/** R1 — every literal href resolves to a route on disk. */
export function checkResolvable(
  root: string,
  patterns: Set<string> = routePatterns(root),
): Finding[] {
  const findings: Finding[] = [];

  for (const file of sourceFiles(root).filter(inScope)) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const site of hrefsIn(file, text)) {
      if (site.pattern === null) continue;
      if (isOutOfScope(site.pattern)) continue;

      const candidate = hrefPath(site.pattern);
      if (resolves(candidate, patterns)) continue;

      findings.push({
        file,
        rule: "R1",
        message:
          `href \`${site.raw}\` resolves to no route under ${APP_SEGMENT_ROOT}. ` +
          "`typedRoutes` cannot catch this any more — under " +
          "`localePrefix: \"as-needed\"` the generated `Route` type describes the " +
          "segment tree and these hrefs are public paths, so `href` is `string`.",
      });
    }
  }

  return findings;
}

/** R2 — no href carries a locale prefix of its own. */
export function checkUnprefixed(root: string): Finding[] {
  const findings: Finding[] = [];
  const prefixes = LOCALES.map((locale) => `/${locale}`);

  for (const file of sourceFiles(root).filter(inScope)) {
    const text = readFileSync(path.join(root, file), "utf8");
    for (const site of hrefsIn(file, text)) {
      if (site.pattern === null) continue;

      const candidate = hrefPath(site.pattern);
      const prefix = prefixes.find(
        (value) => candidate === value || candidate.startsWith(`${value}/`),
      );
      if (prefix === undefined) continue;

      findings.push({
        file,
        rule: "R2",
        message:
          `href \`${site.raw}\` begins with the locale prefix \`${prefix}\`. ` +
          "`@/i18n/navigation`'s `Link` adds the prefix per locale, so this one " +
          "is applied twice for every non-default locale and, for the default " +
          "locale, names a URL that next-intl answers with a redirect.",
      });
    }
  }

  return findings;
}

/**
 * R3 — the files with a non-literal href are the ones declared here.
 *
 * R1 and R2 can say nothing about `href={target}`, so the honest thing is to
 * skip it — and the dishonest thing is to let that skip spread. The list is the
 * audit: a new file whose href this gate cannot read has to be added here, and
 * adding it is where someone asks whether the href could have been a literal.
 */
export const UNRESOLVABLE_ALLOWED: readonly { file: string; why: string }[] = [
  {
    file: "src/components/nav/nav-links.tsx",
    why: "renders `href={href}` over NAV_ITEMS; the literals are in nav-items.ts, which this gate reads through the object-literal path",
  },
  {
    file: "src/components/a11y/skip-link.tsx",
    why: "`href={SKIP_LINK_HREF}` is the in-page fragment the skip link targets, not a route",
  },
  {
    file: "src/components/third-party/third-party-scripts.tsx",
    why: "`href={origin}` is a rel=preconnect to a third-party origin; `src/lib/third-party/catalogue.ts` is the audit over those",
  },
];

export function checkUnresolvableAudit(
  root: string,
  options: CheckOptions = {},
): Finding[] {
  const allowed = new Set(
    options.unresolvableAllowed ??
      UNRESOLVABLE_ALLOWED.map((exception) => exception.file),
  );
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const file of sourceFiles(root).filter(inScope)) {
    const text = readFileSync(path.join(root, file), "utf8");
    const unresolvable = hrefsIn(file, text).filter(
      (site) => site.pattern === null,
    );
    if (unresolvable.length === 0) continue;

    seen.add(file);
    if (allowed.has(file)) continue;

    findings.push({
      file,
      rule: "R3",
      message:
        `has ${unresolvable.length} href(s) this gate cannot read ` +
        `(${unresolvable.map((site) => `\`${site.raw}\``).join(", ")}). ` +
        "A literal href is checked against the route tree; this one is not. " +
        "Make it a literal, or add the file to UNRESOLVABLE_ALLOWED with a " +
        "reason in the review.",
    });
  }

  for (const file of allowed) {
    if (seen.has(file)) continue;
    findings.push({
      file,
      rule: "R3",
      message:
        "is in UNRESOLVABLE_ALLOWED and has no unreadable href. The exemption " +
        "is stale — remove it, or this list stops describing the tree.",
    });
  }

  return findings;
}

export function check(root: string, options: CheckOptions = {}): Finding[] {
  const patterns = routePatterns(root);
  return [
    ...checkResolvable(root, patterns),
    ...checkUnprefixed(root),
    ...checkUnresolvableAudit(root, options),
  ];
}

function main(): void {
  const root = process.argv[2] ?? process.cwd();
  const findings = check(root);

  if (findings.length > 0) {
    process.stderr.write(
      `assert-locale-hrefs: ${findings.length} finding(s).\n\n`,
    );
    for (const finding of findings) {
      process.stderr.write(`  [${finding.rule}] ${finding.file}\n`);
      process.stderr.write(`    ${finding.message}\n\n`);
    }
    process.exitCode = 1;
    return;
  }

  const patterns = routePatterns(root);
  process.stdout.write(
    `Locale hrefs OK — ${patterns.size} route(s) on disk, ` +
      `${sourceFiles(root).filter(inScope).length} source file(s) scanned.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
