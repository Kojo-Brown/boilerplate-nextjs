/**
 * Asserts that route focus management is still wired up, and that every
 * document the build wrote has somewhere for the skip link to go.
 *
 * The whole feature fails silently. A `<main>` that lost its `tabindex`, a
 * route that wraps its content in a bare `<div>`, a provider inserted above
 * the skip link, a `<RouteFocus>` whose `usePathname` was refactored away:
 * each of them builds, renders identically, passes every other gate, and
 * leaves the application exactly as it was before the feature existed —
 * keyboard navigation that stops working after the first client-side
 * navigation, and a "Skip to main content" link that moves the viewport
 * without moving the focus. None of it is visible to a mouse.
 *
 * Six rules, in two groups. R1–R3 read the source, because that is where the
 * wiring is. R4–R6 read the build output, because the source cannot tell you
 * what composition produced — the skip link's position in `<body>` is decided
 * by every provider above it, and a duplicate landmark id can arrive from a
 * route nobody edited.
 *
 *  - **R1** The root layout renders `<SkipLink>` and `<RouteFocus>`.
 *  - **R2** No module renders a raw `<main>`. There is one landmark component
 *    and one landmark id.
 *  - **R3** `<RouteFocus>` is a client module, reads the pathname behind a
 *    hydration gate, and focuses with `preventScroll`.
 *  - **R4** Every prerendered document has exactly one `#main-content`, and it
 *    carries `tabindex="-1"`.
 *  - **R5** The skip link is the first focusable element in the document.
 *  - **R6** Every document that was covered before is still covered.
 *
 * Usage: tsx scripts/assert-focus-management.ts [path-to-.next] [repo-root]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { MAIN_CONTENT_ID, SKIP_LINK_HREF } from "../src/lib/a11y/route-focus";

export const ROOT_LAYOUT = "src/app/[locale]/layout.tsx";
export const ROUTE_FOCUS_MODULE = "src/components/a11y/route-focus.tsx";
export const LANDMARK_MODULE = "src/components/a11y/main-content.tsx";
export const SKIP_LINK_COMPONENT = "SkipLink";
export const ROUTE_FOCUS_COMPONENT = "RouteFocus";

/**
 * The only modules allowed to write `<main>`.
 *
 * `main-content.tsx` is the landmark itself. `global-error.tsx` replaces the
 * root layout rather than nesting inside it — it is the document rendered when
 * the layout that links the stylesheet is what threw — so it has no skip link
 * to be the target of, carries its own inline styles, and cannot import a
 * component that reaches for Tailwind. It is a standalone document that
 * happens to contain a `<main>`, not a route in this application's tree.
 */
export const RAW_MAIN_ALLOWED = [
  LANDMARK_MODULE,
  "src/app/global-error.tsx",
] as const;

/**
 * Documents exempt from R4 and R5, each because of a property of the document
 * rather than a property of this application.
 *
 * An exemption that stops matching anything fails the gate, for the same
 * reason the accessibility gate's allowances do: an exemption nobody needs is
 * a hole waiting for the next regression.
 */
export interface DocumentAllowance {
  /** Document path as `collectDocuments` reports it. */
  readonly document: string;
  readonly because: string;
}

export const ALLOWANCES: readonly DocumentAllowance[] = [
  {
    document: "/_global-error",
    because:
      "Next generates this static 500 document itself and it does not nest " +
      "inside the root layout, so it has neither the skip link nor the " +
      "landmark the skip link targets. `src/app/global-error.tsx` is what " +
      "fixes the runtime boundary a visitor actually lands on, and it " +
      "renders its own <main>",
  },
  {
    document: "/(.)photos/[id]",
    because:
      "the `@modal` interception shell. Both `children` and `modal` are " +
      "streamed holes in it — the prerendered body is the skip link and " +
      "nothing else — and it is only ever served into a document that " +
      "already has the gallery's landmark in it, because interception " +
      "requires a soft navigation from /photos",
  },
  {
    document: "/(.)photos/mountain-golden-hour",
    because: "the same interception shell, for a seeded photo",
  },
  {
    document: "/(.)photos/ocean-at-sunset",
    because: "the same interception shell, for a seeded photo",
  },
  {
    document: "/(.)photos/stars-over-the-range",
    because: "the same interception shell, for a seeded photo",
  },
];

/**
 * Documents that must exist and must be audited.
 *
 * The direction R4 cannot check: it covers whatever the build wrote, so a
 * route that stops prerendering leaves the gate green over one fewer
 * document. `/_not-found` is the one that matters most here — it is a file
 * whose only purpose is to carry the landmark, and deleting it restores
 * Next's built-in 404, which renders perfectly and has no `<main>`.
 */
export const REQUIRED_DOCUMENTS = [
  "/index",
  "/_not-found",
  "/login",
  "/register",
  "/forbidden",
  "/blog",
  "/photos",
  "/pricing",
  "/dashboard",
  "/posts",
  "/admin",
  "/settings/security",
  "/upload",
  "/images",
] as const;

export interface Finding {
  readonly file: string;
  readonly rule: string;
  readonly message: string;
}

export interface SourceFile {
  readonly relativePath: string;
  readonly text: string;
}

export interface PrerenderedDocument {
  /** Path under `.next/server/app`, without the extension. */
  readonly document: string;
  readonly html: string;
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

function jsxTagName(node: ts.Node): string | null {
  if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
    return node.tagName.getText();
  }
  return null;
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

/** Whether any JSX element in the module is named `tag`. */
export function rendersElement(source: ts.SourceFile, tag: string): boolean {
  let found = false;
  walk(source, (node) => {
    if (jsxTagName(node) === tag) found = true;
  });
  return found;
}

/** The names called as plain functions anywhere in a module. */
export function calls(source: ts.SourceFile, name: string): boolean {
  let called = false;
  walk(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      called = true;
    }
  });
  return called;
}

/** R1 — the root layout mounts both components, and defers the router read. */
export function checkRootLayout(files: readonly SourceFile[]): Finding[] {
  const layout = files.find((file) => file.relativePath === ROOT_LAYOUT);
  if (!layout) {
    return [
      { file: ROOT_LAYOUT, rule: "R1", message: "the root layout is missing" },
    ];
  }

  const source = parse(layout);
  const findings: Finding[] = [];

  if (!rendersElement(source, SKIP_LINK_COMPONENT)) {
    findings.push({
      file: ROOT_LAYOUT,
      rule: "R1",
      message:
        `does not render <${SKIP_LINK_COMPONENT}>. It belongs here and ` +
        "nowhere else: it must be the first focusable element in the " +
        "document, and the root layout is the only node every route shares",
    });
  }

  if (!rendersElement(source, ROUTE_FOCUS_COMPONENT)) {
    findings.push({
      file: ROOT_LAYOUT,
      rule: "R1",
      message:
        `does not render <${ROUTE_FOCUS_COMPONENT}>. A layout does not ` +
        "re-render when the visitor moves between sibling routes inside it, " +
        "so a copy mounted in a route group sees a first render — and " +
        "declines to move focus — at every crossing between groups",
    });
  }

  return findings;
}

/** R2 — nothing renders a raw `<main>`. */
export function checkNoRawMain(files: readonly SourceFile[]): Finding[] {
  const allowed = new Set<string>(RAW_MAIN_ALLOWED);

  return files
    .filter(
      (file) =>
        !allowed.has(file.relativePath) && rendersElement(parse(file), "main"),
    )
    .map((file) => ({
      file: file.relativePath,
      rule: "R2",
      message:
        "renders a raw <main>. Use <MainContent>: a second landmark means a " +
        `second element able to carry id="${MAIN_CONTENT_ID}", and a bare ` +
        "<main> has no tabindex, so the skip link scrolls to it and leaves " +
        "focus in the header",
    }));
}

/** R3 — the focus manager is a client module that reads the route. */
export function checkRouteFocusModule(files: readonly SourceFile[]): Finding[] {
  const manager = files.find(
    (file) => file.relativePath === ROUTE_FOCUS_MODULE,
  );
  if (!manager) {
    return [
      {
        file: ROUTE_FOCUS_MODULE,
        rule: "R3",
        message: "the focus manager is missing",
      },
    ];
  }

  const findings: Finding[] = [];
  const source = parse(manager);

  if (!isClientModule(source)) {
    findings.push({
      file: ROUTE_FOCUS_MODULE,
      rule: "R3",
      message: `is not a "use client" module, so none of it runs`,
    });
  }

  if (!manager.text.includes("usePathname")) {
    findings.push({
      file: ROUTE_FOCUS_MODULE,
      rule: "R3",
      message:
        "does not read usePathname(). It renders null either way, so a " +
        "manager that has stopped observing navigations looks exactly like " +
        "a working one",
    });
  }

  if (!calls(source, "useIsHydrated")) {
    findings.push({
      file: ROUTE_FOCUS_MODULE,
      rule: "R3",
      message:
        "does not gate the router read behind useIsHydrated(). " +
        "`usePathname()` cannot be answered while prerendering a fallback " +
        "shell for a dynamic segment, so a module that calls it during a " +
        "prerender suspends — and at the root of the tree that empties the " +
        "shells for /blog/[slug], /photos/[id], /posts/[id] and " +
        "/pricing/v/[variant]. A <Suspense> boundary is not the fix: it " +
        "trades the empty shells for a pending boundary with an empty " +
        "fallback in every one of them, which assert-streaming-boundaries.ts " +
        "fails on for its own good reasons",
    });
  }

  if (!manager.text.includes("preventScroll")) {
    findings.push({
      file: ROUTE_FOCUS_MODULE,
      rule: "R3",
      message:
        "does not focus with `preventScroll`. The router already owns the " +
        "scroll position — top on a push, the previous offset on a pop — and " +
        "focusing scrolls into view by default, so the two fight on every " +
        "Back press. It is reported as a scroll bug, not an accessibility one",
    });
  }

  return findings;
}

/**
 * The elements a keyboard reaches, in document order.
 *
 * Deliberately a small, explicit tag list rather than a full focusability
 * analysis: the question R5 asks is only "is the skip link first", and the
 * first focusable element in a page of this application's shape is an anchor,
 * a button or a form control. Something exotic appearing above the skip link
 * is a change this gate should be rewritten for rather than quietly extended
 * to tolerate.
 */
export const FOCUSABLE_TAGS = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
] as const;

export function firstFocusableTag(bodyHtml: string): string | null {
  const match = new RegExp(`<(${FOCUSABLE_TAGS.join("|")})(\\s|>)`, "i").exec(
    bodyHtml,
  );
  return match?.[1]?.toLowerCase() ?? null;
}

/** The document's `<body>` content, or the whole string if there is no body. */
export function bodyOf(html: string): string {
  const start = html.indexOf("<body");
  if (start === -1) return html;
  const end = html.indexOf("</body>", start);
  return end === -1 ? html.slice(start) : html.slice(start, end);
}

/** R4 and R5, per document. */
export function checkDocument(document: PrerenderedDocument): Finding[] {
  const findings: Finding[] = [];
  const body = bodyOf(document.html);

  const landmarks = body.match(
    new RegExp(`id="${MAIN_CONTENT_ID}"`, "g"),
  )?.length;

  if (landmarks === undefined) {
    findings.push({
      file: document.document,
      rule: "R4",
      message:
        `has no element with id="${MAIN_CONTENT_ID}". The skip link in this ` +
        "document points at a fragment that does not exist, so activating " +
        "it does nothing at all",
    });
  } else if (landmarks > 1) {
    findings.push({
      file: document.document,
      rule: "R4",
      message:
        `has ${landmarks} elements with id="${MAIN_CONTENT_ID}". The ` +
        "fragment resolves to whichever the browser saw first and " +
        "<RouteFocus> focuses whichever getElementById returns, which need " +
        "not be the same one",
    });
  } else {
    // The attribute order React emits is stable, but asserting on it would
    // make this gate a snapshot of the renderer. The window is wide enough to
    // span the element's own attributes and narrow enough not to reach the
    // next element.
    const landmarkStart = body.indexOf(`id="${MAIN_CONTENT_ID}"`);
    const element = body.slice(
      Math.max(0, landmarkStart - 200),
      body.indexOf(">", landmarkStart) + 1,
    );

    if (!element.includes('tabindex="-1"')) {
      findings.push({
        file: document.document,
        rule: "R4",
        message:
          `the ${MAIN_CONTENT_ID} element has no tabindex="-1", so it cannot ` +
          "be focused. The skip link scrolls it into view and leaves focus " +
          "on <body>, which puts the next Tab back in the header — the " +
          "single most common way a skip link ships broken, and invisible to " +
          "a mouse",
      });
    }

    if (!/<main[\s>]/i.test(element)) {
      findings.push({
        file: document.document,
        rule: "R4",
        message: `the ${MAIN_CONTENT_ID} element is not a <main> landmark`,
      });
    }
  }

  const hrefIndex = body.indexOf(`href="${SKIP_LINK_HREF}"`);
  if (hrefIndex === -1) {
    findings.push({
      file: document.document,
      rule: "R5",
      message: `has no skip link (no href="${SKIP_LINK_HREF}")`,
    });
  } else {
    // The *tag*, not the attribute. Slicing at the `href` leaves the skip
    // link's own `<a ` in the text being searched, so every document in the
    // application reported an anchor ahead of the skip link — a gate that
    // fails everywhere is as uninformative as one that passes everywhere.
    const skipLinkIndex = body.lastIndexOf("<a", hrefIndex);
    const before = body.slice(0, Math.max(0, skipLinkIndex));
    const earlier = firstFocusableTag(before);
    if (earlier !== null) {
      findings.push({
        file: document.document,
        rule: "R5",
        message:
          `has a <${earlier}> before the skip link. A skip link that comes ` +
          "after the navigation it exists to skip is decoration — and this " +
          "is not something the source shows, because the root layout's " +
          "children are composed from several providers",
      });
    }
  }

  return findings;
}

/** R6 — every document the gate used to cover is still there. */
export function checkRequiredDocuments(
  documents: readonly PrerenderedDocument[],
): Finding[] {
  const present = new Set(documents.map((document) => document.document));

  return REQUIRED_DOCUMENTS.filter((required) => !present.has(required)).map(
    (required) => ({
      file: required,
      rule: "R6",
      message:
        "is not in the build output. A route that stops prerendering leaves " +
        "this gate green over one fewer document, so the coverage is written " +
        "down rather than derived",
    }),
  );
}

/** Every allowance must still match a document that needs it. */
export function checkAllowances(
  documents: readonly PrerenderedDocument[],
): Finding[] {
  const present = new Set(documents.map((document) => document.document));

  return ALLOWANCES.filter((allowance) => !present.has(allowance.document)).map(
    (allowance) => ({
      file: allowance.document,
      rule: "A1",
      message:
        "is allowed to have no landmark, but no such document was built. An " +
        "exemption nobody needs is a hole waiting for the next regression — " +
        `remove it. It was allowed because ${allowance.because}`,
    }),
  );
}

export function collectSources(root: string): SourceFile[] {
  const files: SourceFile[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name)
      ) {
        files.push({
          relativePath: path.relative(root, absolute).split(path.sep).join("/"),
          text: readFileSync(absolute, "utf8"),
        });
      }
    }
  }

  visit(path.join(root, "src"));
  return files;
}

export function collectDocuments(buildDir: string): PrerenderedDocument[] {
  const appDir = path.join(buildDir, "server", "app");
  if (!existsSync(appDir)) return [];

  const documents: PrerenderedDocument[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.name.endsWith(".html")) {
        const relative = path.relative(appDir, absolute);
        documents.push({
          document: `/${relative.slice(0, -".html".length)}`
            .split(path.sep)
            .join("/"),
          html: readFileSync(absolute, "utf8"),
        });
      }
    }
  }

  visit(appDir);
  return documents.sort((a, b) => a.document.localeCompare(b.document));
}

export function main(buildDir: string, root: string): number {
  const sources = collectSources(root);
  const documents = collectDocuments(buildDir);

  if (documents.length === 0) {
    console.error(
      `No prerendered documents under ${path.join(buildDir, "server", "app")}` +
        " — run `pnpm build` first.",
    );
    return 1;
  }

  const exempt = new Set(ALLOWANCES.map((allowance) => allowance.document));
  const audited = documents.filter(
    (document) => !exempt.has(document.document),
  );

  const findings = [
    ...checkRootLayout(sources),
    ...checkNoRawMain(sources),
    ...checkRouteFocusModule(sources),
    ...audited.flatMap(checkDocument),
    ...checkRequiredDocuments(documents),
    ...checkAllowances(documents),
  ];

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}  [${finding.rule}] ${finding.message}`);
    }
    console.error(
      `\nFocus management gate failed with ${findings.length} finding(s).`,
    );
    return 1;
  }

  console.log(
    `Focus management OK — <${SKIP_LINK_COMPONENT}> is first in the body and ` +
      `exactly one focusable #${MAIN_CONTENT_ID} landmark exists in each of ` +
      `${audited.length} prerendered document(s); ${exempt.size} exempt, ` +
      `<${ROUTE_FOCUS_COMPONENT}> is mounted in ${ROOT_LAYOUT}, reads the ` +
      "router only after hydration, and focuses with preventScroll.",
  );
  return 0;
}

/* c8 ignore start -- CLI entry; the logic above is what the tests exercise. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(
      process.argv[2] ?? path.join(process.cwd(), ".next"),
      process.argv[3] ?? process.cwd(),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
/* c8 ignore stop */
