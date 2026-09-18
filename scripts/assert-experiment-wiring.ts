/**
 * Asserts that the experiments this repository declares are the experiments it
 * actually runs.
 *
 * This gate exists because every way this feature breaks produces a working
 * application. That is not a figure of speech — it is the defining property of
 * the thing:
 *
 *  - Delete the two calls from `src/proxy.ts` and every visitor is served the
 *    canonical page. No error, no 404, no failing test: the control arm is a
 *    real page, deliberately, so that bucketing can fail safe. The only symptom
 *    is an experiment whose treatment arm has no traffic in it, which looks
 *    exactly like an experiment nobody has reached yet.
 *  - Add a third arm to the registry and forget the page, and the arm's share
 *    of traffic gets the not-found boundary instead of a pricing page. The
 *    registry is valid, the weights sum, the types check.
 *  - Drop the `headers.delete` loop in `@/lib/experiments/edge` and the
 *    application starts believing a header any client can send. Nothing about
 *    the request path changes for anyone who is not attacking it.
 *  - Add a `cookies()` read to the pricing page and the variant pages stop
 *    prerendering — which the route-shape gate does catch, but only after this
 *    one explains that the reason those pages must stay static is that the
 *    proxy is what varies them.
 *  - Drop the `headers()` block from `next.config.ts` and the canonical path
 *    goes back to the prerender's own `s-maxage=31536000`. A CDN then stores
 *    one visitor's arm under `/pricing` and serves it to everyone behind it,
 *    and the experiment goes on reporting a difference between two populations
 *    that were never split. Every environment a developer looks at — `next
 *    dev`, `next start`, a preview — has no CDN in front of it, so this one is
 *    invisible right up until it is production-only.
 *
 * So the wiring is what we assert: the registry is internally consistent, the
 * files each declared route needs are on disk, the proxy still calls the two
 * functions, the internal headers are still stripped, the arms the pages know
 * about are the arms the registry hands out, and the canonical path still
 * declares itself uncacheable by shared caches.
 *
 * Static analysis, so it needs no build output.
 *
 * Usage: tsx scripts/assert-experiment-wiring.ts [repo-root]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { ROUTE_BUDGETS } from "./assert-bundle-budget";
import { EXPECTED_ROUTES } from "./assert-route-shape";
import { INTERNAL_REQUEST_HEADERS } from "../src/lib/experiments/edge";
import {
  EXPERIMENTS,
  validateRegistry,
  type Experiment,
} from "../src/lib/experiments/definitions";

export const PROXY_MODULE = "src/proxy.ts";
export const EDGE_MODULE = "src/lib/experiments/edge.ts";
export const NEXT_CONFIG = "next.config.ts";

/** The two calls that make bucketing happen at all. */
export const REQUIRED_PROXY_CALLS = [
  "resolveExperimentContext",
  "applyExperiments",
] as const;

/**
 * Reads that would make an experiment's pages dynamic.
 *
 * The whole arrangement — proxy decides, page renders — exists so that both
 * arms prerender. A page that reads the assignment header itself would be the
 * natural way to write this feature and would cost every visitor a
 * server-rendered page. `auth` is here for the same reason it is called out in
 * `app/photos/layout.tsx`: it reads cookies.
 */
export const REQUEST_SCOPED_READS = [
  "cookies",
  "headers",
  "draftMode",
  "auth",
] as const;

/**
 * Where each routed experiment's page-side arm list lives.
 *
 * Written down rather than derived, as in the route-shape and bundle-budget
 * gates: a list computed from the source would follow it wherever it drifted.
 * An experiment that gains a route and is missing from this table fails the
 * coverage check below.
 */
export interface VariantListLocation {
  readonly experimentId: string;
  readonly module: string;
  readonly constant: string;
}

export const VARIANT_LISTS: readonly VariantListLocation[] = [
  {
    experimentId: "pricing-cta",
    module: "src/app/pricing/_components/variants.ts",
    constant: "PRICING_VARIANT_IDS",
  },
];

export interface Finding {
  file: string;
  rule: string;
  message: string;
}

export interface SourceFile {
  relativePath: string;
  text: string;
}

export type FileReader = (relativePath: string) => string | null;

export function createFileReader(root: string): FileReader {
  return (relativePath) => {
    const absolute = path.join(root, relativePath);
    if (!existsSync(absolute)) return null;
    try {
      return readFileSync(absolute, "utf8");
    } catch {
      return null;
    }
  };
}

function parse(file: SourceFile): ts.SourceFile {
  return ts.createSourceFile(
    file.relativePath,
    file.text,
    ts.ScriptTarget.ES2022,
    true,
    file.relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Names called as plain functions anywhere in a module. */
export function calledFunctions(source: ts.SourceFile): Set<string> {
  const called = new Set<string>();
  walk(source, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      called.add(node.expression.text);
    }
  });
  return called;
}

/** Value (non-type) named imports bound in a module. */
export function importedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (statement.importClause?.isTypeOnly) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) names.add(element.name.text);
      }
    }
  }
  return names;
}

/**
 * The string literals of an exported `as const` array, by name.
 *
 * Only literals are collected: an array built at runtime is not something this
 * gate can read, and treating an unreadable declaration as satisfying the rule
 * is how a check passes on code it never understood.
 */
export function exportedStringArray(
  source: ts.SourceFile,
  name: string,
): string[] | undefined {
  let found: string[] | undefined;

  walk(source, (node) => {
    if (!ts.isVariableDeclaration(node)) return;
    if (!ts.isIdentifier(node.name) || node.name.text !== name) return;

    let initialiser = node.initializer;
    if (initialiser && ts.isAsExpression(initialiser)) {
      initialiser = initialiser.expression;
    }
    if (!initialiser || !ts.isArrayLiteralExpression(initialiser)) return;

    const values: string[] = [];
    for (const element of initialiser.elements) {
      if (!ts.isStringLiteral(element)) return;
      values.push(element.text);
    }
    found = values;
  });

  return found;
}

/**
 * `metadata.robots.index`, if it is written as a literal.
 *
 * Read from the syntax tree rather than with a regular expression, and that is
 * not fastidiousness: the first version of this rule was
 * `/robots:\s*\{[^}]*index:\s*false/` over the file text, and it passed on a
 * page whose metadata said `index: true`, because the doc comment above the
 * export explains the rule and quotes `robots: { index: false }`. A gate that
 * can be satisfied by a comment describing it is worse than no gate, because it
 * reports success.
 *
 * Returns `undefined` when there is no literal to read — an absent `metadata`,
 * a `generateMetadata` function, a spread, a computed value. The caller treats
 * that as a failure: a value this gate cannot read is a value it cannot vouch
 * for.
 */
export function metadataRobotsIndex(
  source: ts.SourceFile,
): boolean | undefined {
  let result: boolean | undefined;

  walk(source, (node) => {
    if (!ts.isVariableDeclaration(node)) return;
    if (!ts.isIdentifier(node.name) || node.name.text !== "metadata") return;

    const initialiser = node.initializer;
    if (!initialiser || !ts.isObjectLiteralExpression(initialiser)) return;

    const robots = initialiser.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "robots",
    );
    if (!robots || !ts.isPropertyAssignment(robots)) return;
    if (!ts.isObjectLiteralExpression(robots.initializer)) return;

    const index = robots.initializer.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "index",
    );
    if (!index || !ts.isPropertyAssignment(index)) return;

    if (index.initializer.kind === ts.SyntaxKind.TrueKeyword) result = true;
    if (index.initializer.kind === ts.SyntaxKind.FalseKeyword) result = false;
  });

  return result;
}

/** Whether a module exports a function or const of this name. */
export function exportsName(source: ts.SourceFile, name: string): boolean {
  let found = false;
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement)
      ? (ts.getModifiers(statement) ?? [])
      : [];
    const exported = modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) continue;

    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      found = true;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === name
        ) {
          found = true;
        }
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** R1 — the registry is internally consistent. */
export function checkRegistry(
  experiments: readonly Experiment[] = EXPERIMENTS,
): Finding[] {
  return validateRegistry(experiments).map((problem) => ({
    file: "src/lib/experiments/definitions.ts",
    rule: "R1",
    message: `${problem.experimentId}: ${problem.message}`,
  }));
}

/** The App Router files a routed experiment needs on disk. */
export function requiredFiles(experiment: Experiment): string[] {
  const { route } = experiment;
  if (!route) return [];

  const canonicalSegment = path.posix.join("src/app", route.path);
  const variantSegment = path.posix.join(
    "src/app",
    route.rewritePrefix,
    "[variant]",
  );

  return [
    `${canonicalSegment}/page.tsx`,
    `${canonicalSegment}/layout.tsx`,
    `${canonicalSegment}/loading.tsx`,
    `${canonicalSegment}/error.tsx`,
    `${variantSegment}/page.tsx`,
    `${variantSegment}/loading.tsx`,
    `${variantSegment}/error.tsx`,
    `${variantSegment}/not-found.tsx`,
  ];
}

/** R2 — every file a declared route needs exists. */
export function checkRouteFiles(
  read: FileReader,
  experiments: readonly Experiment[] = EXPERIMENTS,
): Finding[] {
  const findings: Finding[] = [];

  for (const experiment of experiments) {
    for (const file of requiredFiles(experiment)) {
      if (read(file) !== null) continue;
      findings.push({
        file,
        rule: "R2",
        message:
          `${experiment.id} declares a route that needs this file and it is not there. ` +
          "A missing variant page is the not-found boundary for that arm's share of " +
          "traffic; a missing " +
          "loading or error segment is the repo convention, and on this subtree the " +
          "two arms must share both or the arm is visible before the page resolves",
      });
    }
  }

  return findings;
}

/** R3 — the proxy still does the bucketing. */
export function checkProxyWiring(read: FileReader): Finding[] {
  const text = read(PROXY_MODULE);
  if (text === null) {
    return [{ file: PROXY_MODULE, rule: "R3", message: "is missing entirely" }];
  }

  const source = parse({ relativePath: PROXY_MODULE, text });
  const imported = importedNames(source);
  const called = calledFunctions(source);
  const findings: Finding[] = [];

  for (const name of REQUIRED_PROXY_CALLS) {
    if (!imported.has(name)) {
      findings.push({
        file: PROXY_MODULE,
        rule: "R3",
        message: `does not import ${name}`,
      });
    }
    if (!called.has(name)) {
      findings.push({
        file: PROXY_MODULE,
        rule: "R3",
        message:
          `does not call ${name}(). Without it every visitor is served the canonical ` +
          "arm — which is a working page, so nothing fails; the treatment arm simply " +
          "stops receiving traffic and the experiment reports no effect",
      });
    }
  }

  return findings;
}

/**
 * R4 — the internal headers are stripped from every inbound request.
 *
 * Checked as a loop over the constant rather than as a list of `delete` calls,
 * because the property being asserted is "all of them, by construction". A gate
 * that accepted one `delete` per named header would go on passing after a new
 * header was added to the constant and not to the deletions.
 */
export function checkHeaderSanitising(read: FileReader): Finding[] {
  const text = read(EDGE_MODULE);
  if (text === null) {
    return [{ file: EDGE_MODULE, rule: "R4", message: "is missing entirely" }];
  }

  // Widened deliberately: `INTERNAL_REQUEST_HEADERS` is an `as const` tuple, so
  // TypeScript knows its length is 2 today and calls the comparison below
  // unintentional. It is not — the rule is "the list is not empty", and the day
  // someone empties it is the day it has to fail rather than stop compiling.
  const internal: readonly string[] = INTERNAL_REQUEST_HEADERS;
  if (internal.length === 0) {
    return [
      {
        file: EDGE_MODULE,
        rule: "R4",
        message:
          "INTERNAL_REQUEST_HEADERS is empty, so nothing is stripped and any header " +
          "the proxy forwards can also be sent by a client",
      },
    ];
  }

  const source = parse({ relativePath: EDGE_MODULE, text });
  let strips = false;

  walk(source, (node) => {
    if (!ts.isForOfStatement(node)) return;
    if (!ts.isIdentifier(node.expression)) return;
    if (node.expression.text !== "INTERNAL_REQUEST_HEADERS") return;

    walk(node.statement, (inner) => {
      if (!ts.isCallExpression(inner)) return;
      if (!ts.isPropertyAccessExpression(inner.expression)) return;
      if (inner.expression.name.text === "delete") strips = true;
    });
  });

  if (strips) return [];

  return [
    {
      file: EDGE_MODULE,
      rule: "R4",
      message:
        "does not delete every INTERNAL_REQUEST_HEADERS entry from the inbound request. " +
        "Next merges proxy headers and client headers into one object with no marker " +
        "saying which is which, so a header that is not stripped is a header the caller " +
        "can set and the application will believe",
    },
  ];
}

/** R5 — the arms the pages know about are the arms the registry hands out. */
export function checkVariantLists(
  read: FileReader,
  experiments: readonly Experiment[] = EXPERIMENTS,
  locations: readonly VariantListLocation[] = VARIANT_LISTS,
): Finding[] {
  const findings: Finding[] = [];

  for (const experiment of experiments) {
    if (!experiment.route) continue;

    const location = locations.find(
      (candidate) => candidate.experimentId === experiment.id,
    );
    if (!location) {
      findings.push({
        file: "scripts/assert-experiment-wiring.ts",
        rule: "R5",
        message:
          `${experiment.id} has a route but no entry in VARIANT_LISTS, so nothing ` +
          "checks that its pages render the arms it hands out",
      });
      continue;
    }

    const text = read(location.module);
    if (text === null) {
      findings.push({
        file: location.module,
        rule: "R5",
        message: `is missing; ${experiment.id} has nowhere to declare its arms`,
      });
      continue;
    }

    const source = parse({ relativePath: location.module, text });
    const declared = exportedStringArray(source, location.constant);
    if (!declared) {
      findings.push({
        file: location.module,
        rule: "R5",
        message: `does not export ${location.constant} as an array of string literals`,
      });
      continue;
    }

    const registry = experiment.variants.map((variant) => variant.id);
    const missing = registry.filter((id) => !declared.includes(id));
    const extra = declared.filter((id) => !registry.includes(id));

    if (missing.length > 0) {
      findings.push({
        file: location.module,
        rule: "R5",
        message:
          `${location.constant} is missing ${missing.join(", ")}, which ${experiment.id} ` +
          "gives a share of traffic to. That share gets the not-found boundary instead " +
          "of a pricing page",
      });
    }
    if (extra.length > 0) {
      findings.push({
        file: location.module,
        rule: "R5",
        message:
          `${location.constant} lists ${extra.join(", ")}, which ${experiment.id} no ` +
          "longer has. The page is prerendered for an arm nothing is assigned to",
      });
    }
  }

  return findings;
}

/** R6 — the variant route is a closed, non-indexed set. */
export function checkVariantPage(
  read: FileReader,
  experiments: readonly Experiment[] = EXPERIMENTS,
): Finding[] {
  const findings: Finding[] = [];

  for (const experiment of experiments) {
    const { route } = experiment;
    if (!route) continue;

    const file = path.posix.join(
      "src/app",
      route.rewritePrefix,
      "[variant]",
      "page.tsx",
    );
    const text = read(file);
    if (text === null) continue; // R2 already reported it.

    const source = parse({ relativePath: file, text });

    // `export const dynamicParams = false` would be the direct way to say
    // "and nothing else", and `cacheComponents` rejects it at build time — see
    // the note on `generateStaticParams` in the page itself. `notFound()` is
    // what closes the set instead, so that is what is asserted.
    if (!calledFunctions(source).has("notFound")) {
      findings.push({
        file,
        rule: "R6",
        message:
          "does not call notFound() for an unrecognised arm. `dynamicParams` is not " +
          "available under cacheComponents, so this call is the only thing standing " +
          "between /<prefix>/anything and a page rendered with an arm nothing assigns",
      });
    }

    if (!exportsName(source, "generateStaticParams")) {
      findings.push({
        file,
        rule: "R6",
        message:
          "does not export generateStaticParams, so no arm is prerendered and the " +
          "rewrite lands on a route that has to be rendered per request",
      });
    }

    if (metadataRobotsIndex(source) !== false) {
      findings.push({
        file,
        rule: "R6",
        message:
          "does not export `metadata` with a literal `robots: { index: false }`. The arms " +
          "are near-identical pages at different URLs; indexing them is the " +
          "duplicate-content problem the rewrite exists to avoid, reached the long way " +
          "round",
      });
    }
  }

  return findings;
}

/** Every `.ts`/`.tsx` file under a directory, as repo-relative paths. */
export function collectSourceFiles(root: string, directory: string): string[] {
  const absolute = path.join(root, directory);
  if (!existsSync(absolute)) return [];

  const found: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSourceFiles(root, relative));
    } else if (
      /\.tsx?$/u.test(entry.name) &&
      !/\.test\.tsx?$/u.test(entry.name)
    ) {
      found.push(relative);
    }
  }
  return found;
}

/**
 * R7 — nothing in an experiment's route subtree reads the request.
 *
 * The one rule here that is about performance rather than correctness, and the
 * one most likely to be broken by someone doing the obvious thing: reading the
 * assignment header in the page it decides. That works, and it turns two
 * prerendered documents into a server render on every page view — for a value
 * the proxy has already used to pick which of the two documents to serve.
 */
export function checkNoRequestReads(
  root: string,
  read: FileReader,
  experiments: readonly Experiment[] = EXPERIMENTS,
): Finding[] {
  const findings: Finding[] = [];

  for (const experiment of experiments) {
    const { route } = experiment;
    if (!route) continue;

    const directory = path.posix.join("src/app", route.path);
    for (const file of collectSourceFiles(root, directory)) {
      const text = read(file);
      if (text === null) continue;

      const called = calledFunctions(parse({ relativePath: file, text }));
      for (const name of REQUEST_SCOPED_READS) {
        if (!called.has(name)) continue;
        findings.push({
          file,
          rule: "R7",
          message:
            `calls ${name}(), which makes this route dynamic. The variant is decided in ` +
            "the proxy precisely so both arms can prerender; reading the request here " +
            "gives up the prerender and keeps the rewrite",
        });
      }
    }
  }

  return findings;
}

/** One `{ source, headers: [{ key, value }] }` entry read out of the config. */
export interface ConfigHeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/**
 * The `headers()` rules `next.config.ts` declares, read as literals.
 *
 * The config cannot import the registry — `next typegen` compiles this file to
 * CommonJS without the `@/` alias, so a call into `src/lib/experiments` builds
 * and then fails typegen — so the rules are written out there and checked from
 * here, where the registry *is* available. Reading the values rather than
 * merely confirming a function is called is what makes this a check on the
 * policy instead of on the plumbing.
 *
 * Only string literals are collected: a computed source or value is not
 * something this gate can read, and it will read as a missing rule rather than
 * as a satisfied one.
 */
export function configHeaderRules(source: ts.SourceFile): ConfigHeaderRule[] {
  const rules: ConfigHeaderRule[] = [];

  const stringProperty = (
    node: ts.ObjectLiteralExpression,
    name: string,
  ): string | undefined => {
    const property = node.properties.find(
      (candidate) =>
        ts.isPropertyAssignment(candidate) &&
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === name,
    );
    if (!property || !ts.isPropertyAssignment(property)) return undefined;
    return ts.isStringLiteral(property.initializer)
      ? property.initializer.text
      : undefined;
  };

  walk(source, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;

    const path = stringProperty(node, "source");
    if (path === undefined) return;

    const headersProperty = node.properties.find(
      (candidate) =>
        ts.isPropertyAssignment(candidate) &&
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === "headers",
    );
    if (!headersProperty || !ts.isPropertyAssignment(headersProperty)) return;
    if (!ts.isArrayLiteralExpression(headersProperty.initializer)) return;

    const headers: { key: string; value: string }[] = [];
    for (const element of headersProperty.initializer.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;
      const key = stringProperty(element, "key");
      const value = stringProperty(element, "value");
      if (key !== undefined && value !== undefined)
        headers.push({ key, value });
    }

    rules.push({ source: path, headers });
  });

  return rules;
}

/**
 * R9 — the canonical path is still declared uncacheable by shared caches.
 *
 * The one rule whose failure is invisible in every environment a developer
 * looks at. `/pricing` answers with different markup for two requests that
 * differ only by a cookie, and the prerendered response's own `Cache-Control`
 * is `s-maxage=31536000` — a year in a shared cache, keyed on the URL. A CDN in
 * front of this application would serve whichever arm the first visitor after a
 * purge happened to get, to everybody, and the experiment would go on reporting
 * a difference between two populations that were never split. `next dev`,
 * `next start` and a preview all have no CDN in front of them, so nothing about
 * this shows up until it is production-only.
 *
 * `Vary: Cookie` is the correct HTTP answer to that and Next discards it — see
 * the note in `next.config.ts` for the two builds that establish it — so
 * `Cache-Control` is what is checked.
 */
export function checkCacheHeaders(
  read: FileReader,
  experiments: readonly Experiment[] = EXPERIMENTS,
): Finding[] {
  const text = read(NEXT_CONFIG);
  if (text === null) {
    return [{ file: NEXT_CONFIG, rule: "R9", message: "is missing entirely" }];
  }

  const rules = configHeaderRules(parse({ relativePath: NEXT_CONFIG, text }));
  const findings: Finding[] = [];

  for (const experiment of experiments) {
    const { route } = experiment;
    if (!route) continue;

    const rule = rules.find((candidate) => candidate.source === route.path);
    if (!rule) {
      findings.push({
        file: NEXT_CONFIG,
        rule: "R9",
        message:
          `headers() declares nothing for ${route.path}, so it keeps the prerender's own ` +
          "`s-maxage=31536000`. A shared cache then stores one visitor's arm under that " +
          "URL and serves it to everyone behind it — and the experiment goes on reporting " +
          "a difference between two populations that were never split",
      });
      continue;
    }

    const cacheControl = rule.headers.find(
      (header) => header.key.toLowerCase() === "cache-control",
    );
    if (!cacheControl) {
      findings.push({
        file: NEXT_CONFIG,
        rule: "R9",
        message: `the rule for ${route.path} sets no Cache-Control`,
      });
      continue;
    }

    const directives = cacheControl.value
      .split(",")
      .map((directive) => directive.trim().toLowerCase());

    if (!directives.includes("private") && !directives.includes("no-store")) {
      findings.push({
        file: NEXT_CONFIG,
        rule: "R9",
        message:
          `${route.path} is served with "${cacheControl.value}", which a shared cache may ` +
          "store. The response varies by cookie, so it needs `private` (or `no-store`) — " +
          "`Vary: Cookie` would be the correct answer and Next overwrites it",
      });
    }

    if (directives.some((directive) => directive.startsWith("s-maxage="))) {
      findings.push({
        file: NEXT_CONFIG,
        rule: "R9",
        message:
          `${route.path} is served with "${cacheControl.value}", and s-maxage is an ` +
          "instruction to a shared cache to store exactly the response this path must not " +
          "have stored",
      });
    }
  }

  return findings;
}

/** R8 — the other gates know about these routes. */
export function checkGateCoverage(
  experiments: readonly Experiment[] = EXPERIMENTS,
): Finding[] {
  const findings: Finding[] = [];

  for (const experiment of experiments) {
    const { route } = experiment;
    if (!route) continue;

    const routes = [
      route.path,
      path.posix.join(route.rewritePrefix, "[variant]"),
    ];

    for (const declared of routes) {
      if (
        !EXPECTED_ROUTES.some((expectation) => expectation.route === declared)
      ) {
        findings.push({
          file: "scripts/assert-route-shape.ts",
          rule: "R8",
          message:
            `${declared} is not in EXPECTED_ROUTES. An experiment route that stops ` +
            "prerendering is the failure this whole design is arranged to avoid, and " +
            "nothing would report it",
        });
      }
      if (!ROUTE_BUDGETS.some((budget) => budget.route === declared)) {
        findings.push({
          file: "scripts/assert-bundle-budget.ts",
          rule: "R8",
          message: `${declared} is not in ROUTE_BUDGETS, so it ships unmeasured`,
        });
      }
    }
  }

  return findings;
}

export function main(root: string): number {
  const read = createFileReader(root);

  const findings = [
    ...checkRegistry(),
    ...checkRouteFiles(read),
    ...checkProxyWiring(read),
    ...checkHeaderSanitising(read),
    ...checkVariantLists(read),
    ...checkVariantPage(read),
    ...checkNoRequestReads(root, read),
    ...checkGateCoverage(),
    ...checkCacheHeaders(read),
  ];

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}  [${finding.rule}] ${finding.message}`);
    }
    console.error(
      `\nExperiment wiring gate failed with ${findings.length} finding(s).`,
    );
    return 1;
  }

  const routed = EXPERIMENTS.filter((experiment) => experiment.route);
  console.log(
    `Experiment wiring OK — ${EXPERIMENTS.length} experiment(s), ${routed.length} of ` +
      `them routed (${routed.map((experiment) => experiment.route?.path).join(", ")}). ` +
      `The proxy calls ${REQUIRED_PROXY_CALLS.join(" and ")}, strips ` +
      `${INTERNAL_REQUEST_HEADERS.join(" and ")} from every inbound request, every ` +
      "arm has a prerendered, non-indexed page that reads nothing per request, and " +
      `${NEXT_CONFIG} keeps shared caches off the canonical paths.`,
  );
  return 0;
}

/* c8 ignore start -- CLI entry; the logic above is what the tests exercise. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.cwd());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
/* c8 ignore stop */
