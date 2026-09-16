/**
 * Asserts that every origin this application asks a browser to contact is
 * declared, and that each one loads on the terms it was declared under.
 *
 * The gates beside this one measure what the build produced. That is the right
 * instrument for first-party code and it is blind by construction to third
 * party code: a vendor's script is not in the route manifest, not in a chunk,
 * and adds nothing to any route's first-load JavaScript, so the bundle budget
 * cannot see it, the route-shape gate cannot see it, and a page that spends two
 * seconds of main thread inside someone else's analytics passes every check in
 * this repository. Worse, what that script loads is decided after the build, by
 * someone outside the repository, and can change without a commit here.
 *
 * So the control is a declaration rather than a measurement.
 * `src/lib/third-party/catalogue.ts` is the inventory; this is the audit that
 * keeps the inventory and the source from drifting apart. Eight rules:
 *
 *  R1 **No hand-written `<script>` in the React tree.** A raw tag is fetched
 *     and executed in document order with no strategy at all, which is the
 *     behaviour `next/script` exists to take away from whoever typed it. JSON-LD
 *     (`type="application/ld+json"`) is exempt: it is data the crawler reads,
 *     never executed, and has no network cost. `dangerouslySetInnerHTML` whose
 *     literal content contains a `<script` is the same rule wearing a disguise.
 *
 *  R2 **Every `<Script>` passes an explicit `strategy`.** `next/script` defaults
 *     to `afterInteractive` when the prop is omitted — so the single most
 *     consequential property of a third-party script is decided by whoever
 *     forgot to type it, and the diff that introduced it shows nothing.
 *
 *  R3 **`beforeInteractive` only in the root layout.** Next only honours it
 *     there; anywhere else it is silently demoted, which means a script someone
 *     believed was blocking hydration is not, and nothing says so. In the root
 *     layout it does block hydration on a third party's server responding,
 *     which is a decision that belongs in exactly one reviewable place.
 *
 *  R4 **Every subresource URL's host is in the catalogue.** `src` on a script,
 *     iframe, image, video or audio element and `href` on a `<link>` are the
 *     attributes that cause a request. An absolute URL in one of them is a new
 *     origin on the page, and it must be declared.
 *
 *  R5 **`next.config.ts`'s remote image hosts are in the catalogue, and vice
 *     versa.** An image host is a third party too — a DNS lookup, a TLS
 *     handshake and a request to someone else's server, usually on the critical
 *     path of the largest paint. It is configured in a file no component gate
 *     reads, so it is read here.
 *
 *  R6 **Every declared mount actually mounts its entry.** A `script` or
 *     `facade` entry names the module that loads it; that module must exist and
 *     must import the catalogue constant bound to that entry's id. Both
 *     directions are the point: an inventory entry for something nothing loads
 *     is a lie about what the application does, and a mount that hardcodes a
 *     URL instead of reading the catalogue is an origin the inventory never
 *     heard of.
 *
 *  R7 **`next/script` is imported only by declared mounting modules.** Without
 *     this, R2–R4 are enforced on scripts everywhere while the inventory
 *     silently describes a subset. One import site per entry is what makes the
 *     catalogue exhaustive rather than aspirational.
 *
 *  R8 **Facade and wildcard entries are not preconnected.** Preconnecting a
 *     facade's origin opens a socket and completes a TLS handshake on every
 *     page view, for a resource most visitors never request — which undoes most
 *     of what the facade was built for. A wildcard host (`**.example.com`) has
 *     no origin to name, so the hint is one browsers drop.
 *
 * What this cannot check is behaviour: that the facade renders no iframe before
 * it is pressed is a property of a running component, and it is asserted in
 * `src/components/third-party/video-facade.test.tsx` and in
 * `e2e/third-party.spec.ts`, which watches the network. The division is
 * deliberate — a static gate that pretended to know what a component renders
 * would be a check passing on code it never understood.
 *
 * Static analysis, so it needs no build output.
 *
 * Usage: tsx scripts/assert-third-party-scripts.ts [repo-root]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { THIRD_PARTIES } from "../src/lib/third-party/catalogue";
import type { ThirdParty } from "../src/lib/third-party/catalogue";

export const CATALOGUE_MODULE = "src/lib/third-party/catalogue.ts";
export const CATALOGUE_SPECIFIER = "@/lib/third-party/catalogue";
export const ROOT_LAYOUT = "src/app/layout.tsx";
export const NEXT_CONFIG = "next.config.ts";

/** The `next/script` component, as this repository imports it. */
export const SCRIPT_SPECIFIER = "next/script";

/**
 * JSX attributes that cause a network request, by the tag that carries them.
 *
 * Listed rather than inferred, and `src` is deliberately not treated as
 * universal: it is an attribute name on plenty of components that do not fetch
 * anything, and a gate that fails on all of them would be trained out of
 * existence within a week. `*` covers the tags whose `src` really is a fetch,
 * including the two Next components that wrap them.
 */
export const SUBRESOURCE_ATTRIBUTES: Readonly<
  Record<string, readonly string[]>
> = {
  script: ["src"],
  Script: ["src"],
  iframe: ["src"],
  img: ["src"],
  Image: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  source: ["src", "srcSet"],
  track: ["src"],
  embed: ["src"],
  object: ["data"],
  link: ["href"],
};

export const JSON_LD_TYPE = "application/ld+json";

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

type JsxElementNode = ts.JsxSelfClosingElement | ts.JsxOpeningElement;

function isJsxElementNode(node: ts.Node): node is JsxElementNode {
  return ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node);
}

function tagName(node: JsxElementNode): string {
  return node.tagName.getText();
}

function attribute(
  node: JsxElementNode,
  name: string,
): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name,
  );
}

/**
 * The literal string an attribute was given, or `null` when it was given
 * something this gate cannot read.
 *
 * A computed value is not treated as satisfying anything. Where a rule needs a
 * literal to be sure (R4's origins), an unreadable value is skipped and the
 * catalogue is the only record; where a rule needs a value to be present at all
 * (R2's `strategy`), presence is enough and the expression is the author's
 * business — `strategy={entry.strategy}` reading the catalogue is precisely the
 * spelling this file is trying to encourage.
 */
function literalAttributeValue(attr: ts.JsxAttribute): string | null {
  const { initializer } = attr;
  if (!initializer) return null;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (
    ts.isJsxExpression(initializer) &&
    initializer.expression &&
    ts.isStringLiteral(initializer.expression)
  ) {
    return initializer.expression.text;
  }
  return null;
}

/** Whether a module imports anything from `specifier`. */
export function importsFrom(source: ts.SourceFile, specifier: string): boolean {
  return source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === specifier,
  );
}

/** The names a module imports from one specifier, default import included. */
export function importedNamesFrom(
  source: ts.SourceFile,
  specifier: string,
): Set<string> {
  const names = new Set<string>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== specifier) continue;

    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) names.add(clause.name.text);

    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) names.add(element.name.text);
    }
  }

  return names;
}

/** R1 — no hand-written `<script>`, and no script smuggled through HTML. */
export function checkNoRawScriptTags(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    if (!file.relativePath.endsWith(".tsx")) continue;

    walk(parse(file), (node) => {
      if (isJsxElementNode(node) && tagName(node) === "script") {
        const type = attribute(node, "type");
        if (type && literalAttributeValue(type) === JSON_LD_TYPE) return;

        findings.push({
          file: file.relativePath,
          rule: "R1",
          message:
            "renders a raw <script>. It is fetched and executed in document " +
            "order with no strategy at all — use <Script> from next/script " +
            `and declare the origin in ${CATALOGUE_MODULE}. Structured data ` +
            `(type="${JSON_LD_TYPE}") is the one exception and is not this.`,
        });
        return;
      }

      if (isJsxElementNode(node)) {
        const html = attribute(node, "dangerouslySetInnerHTML");
        // Only a literal is readable here, and only a literal is worth failing
        // on: a computed value is unreadable to this gate either way, and
        // pretending otherwise would mean failing every legitimate use.
        if (!html?.initializer) return;
        const text = html.initializer.getText();
        if (/<script\b/i.test(text)) {
          findings.push({
            file: file.relativePath,
            rule: "R1",
            message:
              "injects a <script> through dangerouslySetInnerHTML. That is a " +
              "raw script tag with an extra step: same execution order, same " +
              "absence of a strategy, and invisible to every other rule here.",
          });
        }
      }
    });
  }

  return findings;
}

/**
 * The tag `next/script`'s default export is bound to in a module, if it is
 * imported at all. Usually `Script`, but the name is the importer's to choose.
 */
function scriptComponentName(source: ts.SourceFile): string | null {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== SCRIPT_SPECIFIER) continue;
    const name = statement.importClause?.name;
    if (name) return name.text;
  }
  return null;
}

/** R2 and R3 — an explicit strategy, and `beforeInteractive` only at the root. */
export function checkScriptStrategies(
  files: readonly SourceFile[],
  rootLayout: string = ROOT_LAYOUT,
): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    const source = parse(file);
    const component = scriptComponentName(source);
    if (!component) continue;

    walk(source, (node) => {
      if (!isJsxElementNode(node)) return;
      if (tagName(node) !== component) return;

      const strategy = attribute(node, "strategy");
      if (!strategy) {
        findings.push({
          file: file.relativePath,
          rule: "R2",
          message:
            `renders <${component}> without a strategy. next/script falls ` +
            "back to afterInteractive, so the load order of a third-party " +
            "script ends up decided by an omission that reads as a default " +
            "nobody chose. Pass the strategy from the catalogue entry.",
        });
        return;
      }

      const value = literalAttributeValue(strategy);
      if (value === "beforeInteractive" && file.relativePath !== rootLayout) {
        findings.push({
          file: file.relativePath,
          rule: "R3",
          message:
            `renders <${component} strategy="beforeInteractive"> outside ` +
            `${rootLayout}. Next only honours beforeInteractive in the root ` +
            "layout; here it is silently demoted to afterInteractive, so the " +
            "script does not do what the code says it does and nothing warns.",
        });
      }
    });
  }

  return findings;
}

/** R7 — only the declared mounting modules may import `next/script`. */
export function checkScriptOwnership(
  files: readonly SourceFile[],
  entries: readonly ThirdParty[] = THIRD_PARTIES,
): Finding[] {
  const allowed = new Set(
    entries
      .map((entry) => entry.mountedBy)
      .filter((module): module is string => module !== null),
  );

  const findings: Finding[] = [];

  for (const file of files) {
    if (allowed.has(file.relativePath)) continue;
    if (!importsFrom(parse(file), SCRIPT_SPECIFIER)) continue;

    findings.push({
      file: file.relativePath,
      rule: "R7",
      message:
        `imports ${SCRIPT_SPECIFIER}, but is not named as the mount of any ` +
        `entry in ${CATALOGUE_MODULE}. Every third-party script is loaded ` +
        "from the module its catalogue entry points at, so that the inventory " +
        "is the whole list rather than the part someone remembered to add.",
    });
  }

  return findings;
}

/** Whether a declared host covers a hostname, wildcards included. */
export function hostMatches(declared: string, hostname: string): boolean {
  if (declared === hostname) return true;
  // `next.config.ts`'s remotePatterns syntax: `**.` matches any number of
  // leading labels, `*.` exactly one.
  if (declared.startsWith("**.")) {
    return hostname.endsWith(declared.slice(2));
  }
  if (declared.startsWith("*.")) {
    const suffix = declared.slice(1);
    if (!hostname.endsWith(suffix)) return false;
    return !hostname.slice(0, -suffix.length).includes(".");
  }
  return false;
}

export function isWildcardHost(host: string): boolean {
  return host.includes("*");
}

function declaredHosts(entries: readonly ThirdParty[]): readonly string[] {
  return entries.flatMap((entry) => entry.hosts);
}

/** R4 — every absolute subresource URL's host is declared. */
export function checkSubresourceOrigins(
  files: readonly SourceFile[],
  entries: readonly ThirdParty[] = THIRD_PARTIES,
): Finding[] {
  const hosts = declaredHosts(entries);
  const findings: Finding[] = [];

  for (const file of files) {
    if (!file.relativePath.endsWith(".tsx")) continue;

    walk(parse(file), (node) => {
      if (!isJsxElementNode(node)) return;

      const attributes = SUBRESOURCE_ATTRIBUTES[tagName(node)];
      if (!attributes) return;

      for (const name of attributes) {
        const attr = attribute(node, name);
        if (!attr) continue;

        const value = literalAttributeValue(attr);
        if (value === null) continue;

        let hostname: string;
        try {
          const url = new URL(value);
          // A data: or blob: URL is bytes the page already has, not an origin
          // it contacts.
          if (url.protocol !== "http:" && url.protocol !== "https:") continue;
          hostname = url.hostname;
        } catch {
          // A relative URL — first-party by definition.
          continue;
        }

        if (hosts.some((host) => hostMatches(host, hostname))) continue;

        findings.push({
          file: file.relativePath,
          rule: "R4",
          message:
            `<${tagName(node)} ${name}="${value}"> requests ${hostname}, ` +
            `which is not declared in ${CATALOGUE_MODULE}. Add an entry ` +
            "saying what it is, how it loads and whether it is worth a " +
            "preconnect — or serve the resource yourself.",
        });
      }
    });
  }

  return findings;
}

/** Every `hostname:` string in `next.config.ts`, wherever it appears. */
export function readImageHostnames(nextConfigText: string): string[] {
  const source = ts.createSourceFile(
    NEXT_CONFIG,
    nextConfigText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );

  const hostnames: string[] = [];
  walk(source, (node) => {
    if (!ts.isPropertyAssignment(node)) return;
    const name = ts.isIdentifier(node.name)
      ? node.name.text
      : ts.isStringLiteral(node.name)
        ? node.name.text
        : null;
    if (name !== "hostname") return;
    if (ts.isStringLiteral(node.initializer)) {
      hostnames.push(node.initializer.text);
    }
  });

  return hostnames;
}

/** R5 — the remote image hosts and the catalogue's asset entries agree. */
export function checkImageHosts(
  nextConfigText: string,
  entries: readonly ThirdParty[] = THIRD_PARTIES,
): Finding[] {
  const configured = readImageHostnames(nextConfigText);
  const assetHosts = entries
    .filter((entry) => entry.loading.mode === "asset")
    .flatMap((entry) => entry.hosts);

  const findings: Finding[] = [];

  for (const hostname of configured) {
    if (assetHosts.includes(hostname)) continue;
    findings.push({
      file: NEXT_CONFIG,
      rule: "R5",
      message:
        `images.remotePatterns permits "${hostname}", which has no entry in ` +
        `${CATALOGUE_MODULE}. next/image makes a remote host look like part ` +
        "of the application; it is a DNS lookup, a handshake and a request to " +
        "someone else's server, usually for the largest element on the page.",
    });
  }

  for (const host of assetHosts) {
    if (configured.includes(host)) continue;
    findings.push({
      file: CATALOGUE_MODULE,
      rule: "R5",
      message:
        `declares the asset host "${host}", which images.remotePatterns does ` +
        "not permit. Either the entry describes a host nothing can load — " +
        "next/image refuses an undeclared origin outright — or the config " +
        "lost a pattern it needs.",
    });
  }

  return findings;
}

/**
 * The exported constant each catalogue id is bound to, read from the
 * catalogue's own source.
 *
 * Read rather than hardcoded so that R6 asks the question it means to ask:
 * "does the mount name *this* entry", not "does the mount contain some string".
 */
export function readIdConstants(
  catalogueText: string,
): ReadonlyMap<string, string> {
  const source = ts.createSourceFile(
    CATALOGUE_MODULE,
    catalogueText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );

  const byId = new Map<string, string>();

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (!declaration.initializer) continue;
      if (!ts.isStringLiteral(declaration.initializer)) continue;
      byId.set(declaration.initializer.text, declaration.name.text);
    }
  }

  return byId;
}

/** R6 — every declared mount exists and names its entry through the catalogue. */
export function checkMounts(
  files: readonly SourceFile[],
  catalogueText: string,
  entries: readonly ThirdParty[] = THIRD_PARTIES,
): Finding[] {
  const idConstants = readIdConstants(catalogueText);
  const findings: Finding[] = [];

  for (const entry of entries) {
    if (entry.loading.mode === "asset") {
      if (entry.mountedBy !== null) {
        findings.push({
          file: CATALOGUE_MODULE,
          rule: "R6",
          message:
            `"${entry.id}" is an asset entry with a mountedBy module. Asset ` +
            "hosts are permitted in next.config.ts and requested by whichever " +
            "next/image receives a matching URL, so there is no single module " +
            "that mounts one and naming one would go stale unnoticed.",
        });
      }
      continue;
    }

    if (entry.mountedBy === null) {
      findings.push({
        file: CATALOGUE_MODULE,
        rule: "R6",
        message:
          `"${entry.id}" loads ${entry.loading.mode} code but names no ` +
          "mountedBy module, so nothing ties the declaration to the code that " +
          "acts on it.",
      });
      continue;
    }

    const mount = files.find((file) => file.relativePath === entry.mountedBy);
    if (!mount) {
      findings.push({
        file: entry.mountedBy,
        rule: "R6",
        message: `is named as the mount of "${entry.id}" but does not exist.`,
      });
      continue;
    }

    const constant = idConstants.get(entry.id);
    if (!constant) {
      findings.push({
        file: CATALOGUE_MODULE,
        rule: "R6",
        message:
          `"${entry.id}" is not exported as a named constant, so its mount ` +
          "has no way to refer to it other than by repeating the string.",
      });
      continue;
    }

    const imported = importedNamesFrom(parse(mount), CATALOGUE_SPECIFIER);
    if (!imported.has(constant)) {
      findings.push({
        file: entry.mountedBy,
        rule: "R6",
        message:
          `does not import ${constant} from ${CATALOGUE_SPECIFIER}. A mount ` +
          "that spells out its own URL and strategy is an origin the " +
          "inventory does not really describe: the two can diverge and only " +
          "the browser would know.",
      });
    }
  }

  return findings;
}

/** R8 — facades and wildcard hosts are never preconnected. */
export function checkPreconnectPolicy(
  entries: readonly ThirdParty[] = THIRD_PARTIES,
): Finding[] {
  const findings: Finding[] = [];

  for (const entry of entries) {
    if (!entry.preconnect) continue;

    if (entry.loading.mode === "facade") {
      findings.push({
        file: CATALOGUE_MODULE,
        rule: "R8",
        message:
          `"${entry.id}" is loaded behind a facade and preconnected. The ` +
          "facade exists so that visitors who never interact with the embed " +
          "pay nothing for it; a preconnect charges every one of them a DNS " +
          "lookup and a TLS handshake anyway. Warm the connection on hover " +
          "and focus inside the facade instead.",
      });
    }

    for (const host of entry.hosts) {
      if (!isWildcardHost(host)) continue;
      findings.push({
        file: CATALOGUE_MODULE,
        rule: "R8",
        message:
          `"${entry.id}" preconnects to the wildcard host "${host}". ` +
          "rel=preconnect takes one origin and a wildcard names none, so the " +
          "hint is dropped — a line that looks like an optimisation and is " +
          "not one.",
      });
    }
  }

  return findings;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/** Every application source file, excluding tests and test helpers. */
export function collectSources(root: string): SourceFile[] {
  const files: SourceFile[] = [];

  function visit(directory: string): void {
    for (const dirent of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, dirent.name);
      const relative = path.relative(root, absolute);

      if (dirent.isDirectory()) {
        // Test doubles deliberately contain the shapes this gate rejects.
        if (relative === path.join("src", "test")) continue;
        visit(absolute);
        continue;
      }

      if (!SOURCE_EXTENSIONS.includes(path.extname(dirent.name))) continue;
      if (/\.test\.tsx?$/.test(dirent.name)) continue;

      files.push({
        relativePath: relative.split(path.sep).join("/"),
        text: readFileSync(absolute, "utf8"),
      });
    }
  }

  visit(path.join(root, "src"));
  return files;
}

export function main(root: string): number {
  const files = collectSources(root);

  const cataloguePath = path.join(root, CATALOGUE_MODULE);
  if (!existsSync(cataloguePath)) {
    console.error(`${CATALOGUE_MODULE}  [R6] the catalogue is missing.`);
    return 1;
  }
  const catalogueText = readFileSync(cataloguePath, "utf8");

  const nextConfigPath = path.join(root, NEXT_CONFIG);
  if (!existsSync(nextConfigPath)) {
    console.error(`${NEXT_CONFIG}  [R5] the Next config is missing.`);
    return 1;
  }
  const nextConfigText = readFileSync(nextConfigPath, "utf8");

  const findings = [
    ...checkNoRawScriptTags(files),
    ...checkScriptStrategies(files),
    ...checkSubresourceOrigins(files),
    ...checkImageHosts(nextConfigText),
    ...checkMounts(files, catalogueText),
    ...checkScriptOwnership(files),
    ...checkPreconnectPolicy(),
  ];

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}  [${finding.rule}] ${finding.message}`);
    }
    console.error(
      `\nThird-party script audit failed with ${findings.length} finding(s).`,
    );
    return 1;
  }

  const scripts = THIRD_PARTIES.filter(
    (entry) => entry.loading.mode === "script",
  ).length;
  const facades = THIRD_PARTIES.filter(
    (entry) => entry.loading.mode === "facade",
  ).length;
  const assets = THIRD_PARTIES.filter(
    (entry) => entry.loading.mode === "asset",
  ).length;

  console.log(
    `Third-party audit OK — ${THIRD_PARTIES.length} declared origin(s): ` +
      `${scripts} script, ${facades} behind a facade, ${assets} asset host(s). ` +
      "Every subresource URL in src/ resolves to a declared host, every " +
      "<Script> carries an explicit strategy, and no facade is preconnected.",
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
