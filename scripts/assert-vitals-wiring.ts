/**
 * Asserts that the Web Vitals pipeline is still connected end to end.
 *
 * The same argument as the gates beside it, applied to a feature whose failure
 * mode is *silence*. Everything here can break without breaking anything: the
 * reporter can vanish from the root layout, the hook subscription can be
 * refactored away, the endpoint can be renamed on one side of the wire. In
 * every case the application builds, renders, passes its unit tests and serves
 * every page correctly. The only symptom is a dashboard that stops filling in
 * — which looks exactly like a dashboard nobody has opened this week, and is
 * discovered, if at all, on the day someone needs the numbers.
 *
 * Five things are checked:
 *
 *  1. **The root layout renders the reporter.** It has to be the root layout
 *     specifically: `useReportWebVitals` must be subscribed before the metrics
 *     it waits for are produced, and LCP and TTFB are produced during the first
 *     paint. A reporter mounted inside a route group misses the landing page on
 *     every visit, and reports a number for every other page, so the data looks
 *     healthy rather than absent.
 *
 *  2. **The reporter still subscribes.** A `"use client"` module that no longer
 *     calls `useReportWebVitals` is a component that renders `null` — which is
 *     what it renders when it is working, too.
 *
 *  3. **It flushes on the events that actually fire, and on no others.** There
 *     is no reliable "page closed" event: `unload` and `beforeunload` are not
 *     dispatched at all on mobile Safari, and — worse — registering a listener
 *     for either disqualifies the page from the back/forward cache. So adding
 *     one both fails to collect the metric and degrades the navigation the
 *     visitor is about to have measured. This fails on their presence as well
 *     as on the absence of `visibilitychange` and `pagehide`.
 *
 *  4. **Both ends agree on the URL.** The browser posts to `VITALS_ENDPOINT`;
 *     that path must be a route handler that exports `POST`. Renaming the
 *     directory is a green build and a 404 per page view.
 *
 *  5. **The endpoint is declared and budgeted.** It must appear in `API_ROUTES`
 *     and `selectPolicy` must return a budget for it. `assert-api-runtimes.ts`
 *     and `assert-rate-limit-coverage.ts` both check this from the build
 *     output; this repeats it from the source so the answer is available in a
 *     second and a gap is named against this feature rather than as a bare
 *     "undeclared route".
 *
 * Static analysis, so it needs no build output.
 *
 * Usage: tsx scripts/assert-vitals-wiring.ts [repo-root]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { findApiRoute } from "../src/lib/api/runtimes";
import { selectPolicy } from "../src/lib/rate-limit/policy";
import { VITALS_ENDPOINT } from "../src/lib/vitals/queue";

export const ROOT_LAYOUT = "src/app/layout.tsx";
export const REPORTER_MODULE = "src/components/vitals/web-vitals-reporter.tsx";
export const REPORTER_COMPONENT = "WebVitalsReporter";

/** Events the reporter must listen for. */
export const REQUIRED_FLUSH_EVENTS = ["visibilitychange", "pagehide"] as const;

/**
 * Events the reporter must not listen for.
 *
 * Not a style preference. Registering either of these is what takes a page out
 * of the back/forward cache, so the cost is paid by the visitor on their next
 * navigation — and paid in the very metric this feature exists to measure.
 */
export const FORBIDDEN_FLUSH_EVENTS = ["unload", "beforeunload"] as const;

export interface SourceFile {
  relativePath: string;
  text: string;
}

export interface Finding {
  file: string;
  rule: string;
  message: string;
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

/** The tag name of a JSX element, as written. */
function jsxTagName(node: ts.Node): string | null {
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  if (ts.isJsxOpeningElement(node)) return node.tagName.getText();
  return null;
}

/** Every named import bound in a module, regardless of where it came from. */
export function importedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    // A type-only import is not a value and cannot be rendered.
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

/** Whether a module opens with the `"use client"` prologue. */
export function isClientModule(source: ts.SourceFile): boolean {
  const first = source.statements[0];
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use client"
  );
}

/** The names called as plain functions anywhere in a module. */
export function calledFunctions(source: ts.SourceFile): Set<string> {
  const called = new Set<string>();
  walk(source, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      called.add(node.expression.text);
    }
  });
  return called;
}

/**
 * The event names passed to `addEventListener`, on any target.
 *
 * Only string literals are collected. An event name built at runtime is not
 * something this gate can read, and treating an unreadable call as satisfying
 * a requirement is how a check passes on code it never understood — so a
 * computed name simply does not count, and the required-event rules fail.
 */
export function listenedEvents(source: ts.SourceFile): Set<string> {
  const events = new Set<string>();
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isPropertyAccessExpression(node.expression)) return;
    if (node.expression.name.text !== "addEventListener") return;

    const [first] = node.arguments;
    if (first && ts.isStringLiteral(first)) events.add(first.text);
  });
  return events;
}

/** R1 — the root layout imports and renders the reporter. */
export function checkRootLayout(files: readonly SourceFile[]): Finding[] {
  const layout = files.find((file) => file.relativePath === ROOT_LAYOUT);
  if (!layout) {
    return [
      {
        file: ROOT_LAYOUT,
        rule: "R1",
        message: "the root layout is missing entirely",
      },
    ];
  }

  const source = parse(layout);
  const findings: Finding[] = [];

  if (!importedNames(source).has(REPORTER_COMPONENT)) {
    findings.push({
      file: ROOT_LAYOUT,
      rule: "R1",
      message: `does not import <${REPORTER_COMPONENT}> as a value`,
    });
  }

  let rendered = false;
  walk(source, (node) => {
    if (jsxTagName(node) === REPORTER_COMPONENT) rendered = true;
  });

  if (!rendered) {
    findings.push({
      file: ROOT_LAYOUT,
      rule: "R1",
      message:
        `does not render <${REPORTER_COMPONENT}>. It has to be mounted here ` +
        "and nowhere else: LCP and TTFB are measured during the first paint, " +
        "so a reporter any deeper in the tree misses the landing page on " +
        "every visit while still reporting for every other page",
    });
  }

  return findings;
}

/** R2 and R3 — the reporter subscribes, and flushes on the right events. */
export function checkReporter(files: readonly SourceFile[]): Finding[] {
  const reporter = files.find((file) => file.relativePath === REPORTER_MODULE);
  if (!reporter) {
    return [
      {
        file: REPORTER_MODULE,
        rule: "R2",
        message: "the reporter module is missing entirely",
      },
    ];
  }

  const source = parse(reporter);
  const findings: Finding[] = [];

  if (!isClientModule(source)) {
    findings.push({
      file: REPORTER_MODULE,
      rule: "R2",
      message: `is not a "use client" module, so the hook cannot run`,
    });
  }

  if (!calledFunctions(source).has("useReportWebVitals")) {
    findings.push({
      file: REPORTER_MODULE,
      rule: "R2",
      message:
        "does not call useReportWebVitals. A reporter that has stopped " +
        "subscribing renders exactly what a working one renders: nothing",
    });
  }

  const events = listenedEvents(source);

  for (const required of REQUIRED_FLUSH_EVENTS) {
    if (!events.has(required)) {
      findings.push({
        file: REPORTER_MODULE,
        rule: "R3",
        message:
          `does not listen for "${required}". Without both of ` +
          `${REQUIRED_FLUSH_EVENTS.join(" and ")} there is no moment at which ` +
          "the buffered batch is reliably sent, and the metrics are simply lost",
      });
    }
  }

  for (const forbidden of FORBIDDEN_FLUSH_EVENTS) {
    if (events.has(forbidden)) {
      findings.push({
        file: REPORTER_MODULE,
        rule: "R3",
        message:
          `listens for "${forbidden}". It is not dispatched at all on mobile ` +
          "Safari, and registering it disqualifies the page from the " +
          "back/forward cache — so it fails to collect the metric and makes " +
          "the visitor's next navigation slower, in the metric this feature " +
          "exists to measure",
      });
    }
  }

  return findings;
}

/** Whether a route handler exists at `routePath` and exports `POST`. */
export type RouteReader = (routePath: string) => string | null;

export function createRouteReader(root: string): RouteReader {
  return (routePath) => {
    const file = path.join(root, "src", "app", routePath, "route.ts");
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  };
}

/** R4 and R5 — both ends agree on the URL, and it is declared and budgeted. */
export function checkEndpoint(readRoute: RouteReader): Finding[] {
  const findings: Finding[] = [];
  const endpoint = VITALS_ENDPOINT;

  const routeText = readRoute(endpoint);
  if (routeText === null) {
    findings.push({
      file: `src/app${endpoint}/route.ts`,
      rule: "R4",
      message:
        `VITALS_ENDPOINT is "${endpoint}" but no route handler exists there. ` +
        "The browser would post a beacon per page view into a 404, which " +
        "nothing observes because a beacon's response is discarded",
    });
  } else {
    const exportsPost = parse({
      relativePath: `src/app${endpoint}/route.ts`,
      text: routeText,
    }).statements.some(
      (statement) =>
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ) === true &&
        statement.declarationList.declarations.some(
          (declaration) =>
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === "POST",
        ),
    );

    if (!exportsPost) {
      findings.push({
        file: `src/app${endpoint}/route.ts`,
        rule: "R4",
        message:
          "does not export POST, which is the only method the client uses",
      });
    }
  }

  if (!findApiRoute(endpoint)) {
    findings.push({
      file: "src/lib/api/runtimes.ts",
      rule: "R5",
      message: `${endpoint} is not declared in API_ROUTES`,
    });
  }

  const policy = selectPolicy({
    method: "POST",
    pathname: endpoint,
    isServerAction: false,
  });

  if (!policy) {
    findings.push({
      file: "src/lib/rate-limit/policy.ts",
      rule: "R5",
      message:
        `POST ${endpoint} matches no rate limit rule. It is an ` +
        "unauthenticated endpoint that can be configured to forward each " +
        "batch to a collector, which makes one cheap POST into one outbound " +
        "request",
    });
  }

  return findings;
}

export function collectSources(root: string): SourceFile[] {
  return [ROOT_LAYOUT, REPORTER_MODULE]
    .filter((relativePath) => existsSync(path.join(root, relativePath)))
    .map((relativePath) => ({
      relativePath,
      text: readFileSync(path.join(root, relativePath), "utf8"),
    }));
}

export function main(root: string): number {
  const files = collectSources(root);

  const findings = [
    ...checkRootLayout(files),
    ...checkReporter(files),
    ...checkEndpoint(createRouteReader(root)),
  ];

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}  [${finding.rule}] ${finding.message}`);
    }
    console.error(
      `\nWeb Vitals wiring gate failed with ${findings.length} finding(s).`,
    );
    return 1;
  }

  console.log(
    `Web Vitals wiring OK — <${REPORTER_COMPONENT}> is mounted in ` +
      `${ROOT_LAYOUT}, subscribes to useReportWebVitals, flushes on ` +
      `${REQUIRED_FLUSH_EVENTS.join(" and ")}, and posts to a declared, ` +
      `rate-limited ${VITALS_ENDPOINT}.`,
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
