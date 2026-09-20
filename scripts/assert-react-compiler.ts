/**
 * Asserts that React Compiler is enabled, that it actually compiles every
 * component in the client graph, and that no manual memoization has crept back
 * in without a reason attached.
 *
 * The same argument as the gates beside it, applied to an optimization whose
 * every failure mode is a working application.
 *
 * Turning the compiler on is one line in `next.config.ts`, and once it is on
 * the manual `useMemo`/`useCallback`/`memo()` that existed to do its job by
 * hand are dead weight — so they were removed (see docs/react-compiler.md).
 * That removal is only safe while the compiler is actually compiling the
 * components they were removed from, and there are three separate ways for it
 * to quietly stop:
 *
 *  - The config line is deleted, or a future Next moves the option. Nothing
 *    breaks. Every page renders, every test passes, and the application is
 *    back to no memoization at all — worse than where it started, because the
 *    hand-written memos are gone.
 *
 *  - `babel-plugin-react-compiler` is dropped from the manifest. This one is
 *    loud today (Next throws E78), which is exactly why it is cheap to check
 *    here too: a gate that only catches the noisy failures is a gate whose
 *    silence means nothing.
 *
 *  - A component uses a construct the compiler does not support. This is the
 *    dangerous one. `panicThreshold` defaults to `"none"`, so the compiler
 *    *skips* what it cannot compile: no error, no warning, no build output
 *    that differs in any observable way. `ImageUpload` was in this state when
 *    the compiler was first enabled — one `onUploadComplete?.(publicUrl)`
 *    inside a `try` block bailed the whole component out — and the only way to
 *    find it was to ask the compiler.
 *
 * So this gate asks the compiler. It runs the real
 * `babel-plugin-react-compiler`, at the same version and with the same
 * defaults the build uses, over the same files the build would hand it, and
 * fails on a bail-out. That is slower than reading source text, and it is the
 * only check here that cannot be fooled by code that looks compilable.
 *
 * Six rules:
 *
 *  R1 **`next.config.ts` enables the compiler.** Read from the config's own
 *     AST rather than by importing it: the file is compiled to CommonJS by
 *     `next typegen` and importing it from here drags that along.
 *
 *  R2 **The build that produced `.next/` had it enabled.** R1 reads a source
 *     file; this reads `required-server-files.json`, which records the config
 *     Next actually resolved. The two disagree exactly when someone edits the
 *     config and something downstream ignores it — a renamed option, a config
 *     that throws and is silently replaced by defaults — which is the case R1
 *     alone cannot see.
 *
 *  R3 **Both compiler packages are declared.** `babel-plugin-react-compiler`
 *     is what Next loads; `@babel/core` is what this gate drives it with.
 *
 *  R4 **Every component in the client graph compiles.** No bail-outs, no
 *     errors. The graph is computed from the `"use client"` entry points and
 *     the modules they import, because that is the only code the compiler is
 *     ever handed: Next does not run it on the server build at all, so a
 *     Server Component using an unsupported construct is not a finding.
 *
 *  R5 **Every surviving manual memo carries a `@memo-keep` justification.**
 *     Not a style rule. With the compiler on, `useMemo`/`useCallback`/`memo()`
 *     means one of two things — a memo that is load-bearing for *correctness*
 *     (React guarantees it; the compiler's memoization is an optimization it
 *     may drop) or a memo nobody got around to deleting. Those are opposite
 *     decisions and they look identical in a diff, so the reason has to be
 *     written down next to the call.
 *
 *  R6 **`"use no memo"` carries one too.** It is the same de-optimization as a
 *     leftover memo, reached from the other direction: an escape hatch added
 *     to unblock a build, left behind, and invisible forever after.
 *
 * There is deliberately no assertion over the emitted chunks. The compiler's
 * output is identifiable in a production bundle only by the shape minification
 * happens to leave behind (`r.H.useMemoCache`, this week), which is a check
 * that would fail on a Terser upgrade and pass on a real regression. R2 reads
 * a manifest Next writes on purpose instead.
 *
 * Usage: tsx scripts/assert-react-compiler.ts [repo-root]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const CONFIG_FILE = "next.config.ts";
export const PACKAGE_FILE = "package.json";
export const SERVER_FILES_MANIFEST = ".next/required-server-files.json";

/** Packages that have to be installed for the compiler to run at all. */
export const REQUIRED_PACKAGES = [
  "babel-plugin-react-compiler",
  "@babel/core",
] as const;

/** Hooks whose only purpose is memoization. */
export const MEMO_HOOKS = ["useMemo", "useCallback"] as const;

/** The directive that opts a function out of compilation. */
export const OPT_OUT_DIRECTIVE = "use no memo";

/**
 * The tag that turns a surviving memo from an oversight into a decision.
 *
 * A tag rather than a table in this file: the reason has to be readable by
 * whoever is looking at the component, not by whoever is looking at the gate,
 * and a second list of file paths is a second thing to rot.
 */
export const KEEP_TAG = "@memo-keep";

/** A reason shorter than this is not a reason. */
export const MIN_REASON_LENGTH = 24;

export interface SourceFile {
  relativePath: string;
  text: string;
}

export interface Finding {
  file: string;
  rule: string;
  message: string;
}

/** One function the compiler was asked to compile. */
export interface CompileEvent {
  /** Repo-relative path of the module it was found in. */
  file: string;
  /** The function's name, or a `line:column` when it is anonymous. */
  name: string;
  /** False for anything the compiler refused or skipped. */
  compiled: boolean;
  /** The compiler's own words, when it refused. */
  reason?: string | undefined;
}

/** Drives the real compiler over one file. Injected so the tests can fake it. */
export type Compiler = (file: SourceFile) => CompileEvent[];

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

/* -------------------------------------------------------------------------- */
/* R1 — the config source                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The value of a top-level property of the `NextConfig` object literal.
 *
 * Narrow on purpose: it only recognises `reactCompiler: true`, which is the
 * only form this repository uses. `{ compilationMode: "annotation" }` is a
 * valid value for the option and a different feature — every new component
 * would ship unmemoized until someone remembered a directive — so it should
 * fail this rule and be argued for in a diff, not pass it silently.
 */
export function readConfigFlag(source: ts.SourceFile): boolean | null {
  let found: boolean | null = null;

  walk(source, (node) => {
    if (!ts.isPropertyAssignment(node)) return;
    if (!ts.isIdentifier(node.name) || node.name.text !== "reactCompiler") {
      return;
    }
    found = node.initializer.kind === ts.SyntaxKind.TrueKeyword;
  });

  return found;
}

export function checkConfig(files: SourceFile[]): Finding[] {
  const config = files.find((file) => file.relativePath === CONFIG_FILE);

  if (!config) {
    return [
      {
        file: CONFIG_FILE,
        rule: "R1",
        message: "the Next config is missing, so nothing enables the compiler",
      },
    ];
  }

  if (readConfigFlag(parse(config)) === true) return [];

  return [
    {
      file: CONFIG_FILE,
      rule: "R1",
      message:
        "`reactCompiler: true` is not set. Every client component in this " +
        "repository has had its manual memoization removed on the " +
        "understanding that the compiler replaces it, so turning this off " +
        "leaves the application with no memoization at all",
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* R2 — what the build actually resolved                                       */
/* -------------------------------------------------------------------------- */

export interface BuildManifest {
  config?: { reactCompiler?: unknown };
}

export function readBuildManifest(root: string): BuildManifest | null {
  const absolute = path.join(root, SERVER_FILES_MANIFEST);
  if (!existsSync(absolute)) return null;
  return JSON.parse(readFileSync(absolute, "utf8")) as BuildManifest;
}

export function checkBuildManifest(manifest: BuildManifest | null): Finding[] {
  if (manifest === null) {
    return [
      {
        file: SERVER_FILES_MANIFEST,
        rule: "R2",
        message:
          "no build output to read. Run `pnpm build` before this gate — it " +
          "checks the config Next resolved, not the one the source declares",
      },
    ];
  }

  if (manifest.config?.reactCompiler === true) return [];

  return [
    {
      file: SERVER_FILES_MANIFEST,
      rule: "R2",
      message:
        "the build that wrote this output resolved " +
        `\`reactCompiler\` to ${JSON.stringify(manifest.config?.reactCompiler)}, ` +
        "not `true`. The source says otherwise, so the option is being " +
        "renamed, ignored, or overridden somewhere between the two",
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* R3 — the packages                                                           */
/* -------------------------------------------------------------------------- */

export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function checkPackages(manifest: PackageManifest): Finding[] {
  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };

  return REQUIRED_PACKAGES.filter((name) => !(name in declared)).map(
    (name) => ({
      file: PACKAGE_FILE,
      rule: "R3",
      message:
        `\`${name}\` is not declared. ` +
        (name === "@babel/core"
          ? "This gate drives the compiler through it, so without it the " +
            "compiler can be checked only by trusting the config"
          : "Next resolves it by name when `reactCompiler` is set and " +
            "throws E78 when it cannot"),
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* The client graph                                                            */
/* -------------------------------------------------------------------------- */

const SOURCE_EXTENSIONS = [".tsx", ".ts"];

function isTest(relativePath: string): boolean {
  return /\.test\.tsx?$/.test(relativePath);
}

/** Every `.ts`/`.tsx` under `src/`, tests excluded. */
export function collectSources(root: string): SourceFile[] {
  const files: SourceFile[] = [];

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }

      if (!/\.tsx?$/.test(entry.name)) continue;
      if (isTest(entry.name)) continue;

      files.push({
        relativePath: path.relative(root, absolute).split(path.sep).join("/"),
        text: readFileSync(absolute, "utf8"),
      });
    }
  };

  visit(path.join(root, "src"));
  return files;
}

/** True when the module opens with the `"use client"` directive. */
export function isClientEntry(file: SourceFile): boolean {
  const source = parse(file);
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement)) break;
    if (!ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use client") return true;
  }
  return false;
}

/** The module specifiers a file imports, re-exports included. */
export function moduleSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  for (const statement of source.statements) {
    const clause =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (clause && ts.isStringLiteral(clause)) specifiers.push(clause.text);
  }

  return specifiers;
}

/**
 * Resolves a specifier against this repository's own modules.
 *
 * Only `@/` and relative paths — a bare specifier is a package, and package
 * code is not ours to compile. Mirrors the `@/` → `src/` mapping in
 * tsconfig.json and Next's own resolution order for extensionless imports.
 */
export function resolveSpecifier(
  fromRelativePath: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | null {
  let base: string;

  if (specifier.startsWith("@/")) {
    base = `src/${specifier.slice(2)}`;
  } else if (specifier.startsWith(".")) {
    base = path.posix.normalize(
      path.posix.join(path.posix.dirname(fromRelativePath), specifier),
    );
  } else {
    return null;
  }

  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];

  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

/**
 * The modules Next hands to the compiler: every `"use client"` entry point and
 * everything reachable from one.
 *
 * Scoped this way because the compiler is a *client* transform — Next passes
 * the plugin only when `isServer` is false — so a Server Component that cannot
 * be compiled is not a problem to fail a build over, and failing on it would
 * make the gate's one real rule unenforceable in practice.
 */
export function collectClientGraph(files: SourceFile[]): SourceFile[] {
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  const known = new Set(byPath.keys());

  const reached = new Set<string>();
  const queue = files.filter(isClientEntry).map((file) => file.relativePath);

  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (reached.has(current)) continue;
    reached.add(current);

    const file = byPath.get(current);
    if (!file) continue;

    for (const specifier of moduleSpecifiers(parse(file))) {
      const resolved = resolveSpecifier(current, specifier, known);
      if (resolved && !reached.has(resolved)) queue.push(resolved);
    }
  }

  return files
    .filter((file) => reached.has(file.relativePath))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/* -------------------------------------------------------------------------- */
/* R4 — the compiler's own verdict                                             */
/* -------------------------------------------------------------------------- */

export function checkCompilation(events: CompileEvent[]): Finding[] {
  return events
    .filter((event) => !event.compiled)
    .map((event) => ({
      file: event.file,
      rule: "R4",
      message:
        `React Compiler could not compile \`${event.name}\`: ` +
        `${event.reason ?? "no reason given"}. ` +
        "It is skipped rather than reported by the build, so this component " +
        "ships with no memoization at all — including whatever was removed " +
        "from it on the understanding that the compiler had taken over. " +
        "Rewrite the construct, or move it into a module-scope function the " +
        "compiler does not treat as a component",
    }));
}

/* -------------------------------------------------------------------------- */
/* R5 / R6 — memoization that survived                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every comment attached to a node or to the statement it belongs to, one
 * entry per comment and no duplicates.
 *
 * Both levels, because a `@memo-keep` block is written where it reads best:
 * above the `const report = useCallback(` statement in one component, and
 * against the call itself in another. Looking only at the call expression
 * would miss the first, which is the common form.
 *
 * Deduplicated by position, because a `VariableDeclarationList` and the
 * `VariableStatement` wrapping it begin at the same offset and so report the
 * same comments — which, joined into one string, let the reason for one memo
 * run into the text of the comment above it and clear the length check on
 * borrowed words.
 */
function leadingComments(source: ts.SourceFile, node: ts.Node): string[] {
  const full = source.getFullText();
  const seen = new Map<number, string>();

  for (
    let current: ts.Node | undefined = node;
    current && current !== source;
    current = current.parent
  ) {
    const ranges =
      ts.getLeadingCommentRanges(full, current.getFullStart()) ?? [];
    for (const range of ranges) {
      seen.set(range.pos, full.slice(range.pos, range.end));
    }
    // Statements are where a doc block usually hangs; stop once one is seen.
    if (ts.isStatement(current)) break;
  }

  return [...seen.values()];
}

/**
 * The reason written after the tag in a single comment, if there is one.
 *
 * One comment at a time on purpose: the reason runs to the end of the comment
 * that carries the tag, and nothing that follows it belongs to the tag.
 */
export function extractReason(comment: string): string | null {
  const index = comment.indexOf(KEEP_TAG);
  if (index === -1) return null;

  return (
    comment
      .slice(index + KEEP_TAG.length)
      // The terminator first, and on the whole body rather than per line: on a
      // multi-line block it sits alone on the last line, where stripping the
      // `*` prefix first leaves a stray `/` inside the reason.
      .replace(/\*\/\s*$/, "")
      .split("\n")
      // A doc block's `*` prefixes are punctuation, not prose. So is a `//`,
      // which is how the tag is written on a run of line comments.
      .map((line) => line.replace(/^\s*(?:\*|\/\/)\s?/, "").trim())
      .filter((line) => line.length > 0)
      .join(" ")
      .trim()
  );
}

/** The first `@memo-keep` reason among a node's comments. */
export function findReason(comments: string[]): string | null {
  for (const comment of comments) {
    const reason = extractReason(comment);
    if (reason !== null) return reason;
  }
  return null;
}

function memoCallName(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;

  const callee = node.expression;
  const name = ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : ts.isIdentifier(callee)
      ? callee.text
      : null;

  if (name === null) return null;
  if ((MEMO_HOOKS as readonly string[]).includes(name)) return name;
  // `memo(Component)` — the call has to take an argument, or `memo` is
  // something else entirely with an unfortunate name.
  if (name === "memo" && node.arguments.length > 0) return name;
  return null;
}

/** One surviving `useMemo`/`useCallback`/`memo()` call, and its reason. */
export interface ManualMemo {
  file: string;
  line: number;
  /** The hook or wrapper that was called. */
  name: string;
  /** The `@memo-keep` reason, or null when there is none. */
  reason: string | null;
}

/** Every manual memoization call left in the given sources. */
export function findManualMemos(files: SourceFile[]): ManualMemo[] {
  const memos: ManualMemo[] = [];

  for (const file of files) {
    const source = parse(file);

    walk(source, (node) => {
      const name = memoCallName(node);
      if (name === null) return;

      memos.push({
        file: file.relativePath,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        name,
        reason: findReason(leadingComments(source, node)),
      });
    });
  }

  return memos;
}

export function checkManualMemos(files: SourceFile[]): Finding[] {
  const findings: Finding[] = [];

  for (const { file, line, name, reason } of findManualMemos(files)) {
    const at = `${file}:${line}`;

    if (reason === null) {
      findings.push({
        file: at,
        rule: "R5",
        message:
          `\`${name}\` with React Compiler enabled. The compiler memoizes ` +
          "this component already, so either this is load-bearing for " +
          "correctness — React guarantees its memoization, the compiler only " +
          "offers one — or it is a leftover that should be deleted. Say " +
          `which with a \`${KEEP_TAG} <reason>\` comment`,
      });
      continue;
    }

    if (reason.length < MIN_REASON_LENGTH) {
      findings.push({
        file: at,
        rule: "R5",
        message:
          `\`${KEEP_TAG}\` on this \`${name}\` says only ` +
          `${JSON.stringify(reason)}. The tag exists to record why the ` +
          "compiler is not enough here; a reason nobody can act on is the " +
          "same as no reason",
      });
    }
  }

  return findings;
}

export function checkOptOuts(files: SourceFile[]): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    const source = parse(file);

    walk(source, (node) => {
      if (
        !ts.isStringLiteral(node) &&
        !ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        return;
      }
      if (node.text !== OPT_OUT_DIRECTIVE) return;
      if (!node.parent || !ts.isExpressionStatement(node.parent)) return;

      const reason = findReason(leadingComments(source, node.parent));
      if (reason !== null && reason.length >= MIN_REASON_LENGTH) return;

      const line =
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

      findings.push({
        file: `${file.relativePath}:${line}`,
        rule: "R6",
        message:
          `\`"${OPT_OUT_DIRECTIVE}"\` opts this function out of the compiler ` +
          "entirely, which is the same de-optimization as a leftover manual " +
          "memo reached from the other side — and unlike one, it leaves " +
          "nothing in the source to notice. Add a " +
          `\`${KEEP_TAG} <reason>\` comment, or remove the directive`,
      });
    });
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Drives `babel-plugin-react-compiler` over one file.
 *
 * `transformSync` and no config file, so what comes back is the plugin's
 * verdict on the source and nothing else. The options match what Next passes
 * in a production build: no `compilationMode` (so `"infer"`), no
 * `panicThreshold` (so `"none"` — which is exactly why the logger, rather than
 * a thrown error, is what has to be read).
 */
export function createCompiler(root: string): Compiler {
  /* c8 ignore start -- requires @babel/core; the tests inject a fake. */
  // `createRequire` rather than a static import: @babel/core is CommonJS and
  // is a dependency of this gate alone, so nothing should pay for loading it
  // when the gate's exports are imported by a test.
  const babel = createRequire(import.meta.url)(
    "@babel/core",
  ) as typeof import("@babel/core");

  return (file) => {
    const events: CompileEvent[] = [];

    const describe = (event: {
      fnName?: unknown;
      fnLoc?: { start?: { line: number; column: number } } | null;
    }): string => {
      if (typeof event.fnName === "string" && event.fnName.length > 0) {
        return event.fnName;
      }
      const start = event.fnLoc?.start;
      return start ? `anonymous at ${start.line}:${start.column}` : "anonymous";
    };

    babel.transformSync(file.text, {
      filename: path.join(root, file.relativePath),
      babelrc: false,
      configFile: false,
      // The sources are TypeScript and the compiler reads them as written;
      // nothing here strips types, because nothing here emits.
      parserOpts: { plugins: ["typescript", "jsx"] },
      plugins: [
        [
          "babel-plugin-react-compiler",
          {
            logger: {
              logEvent: (
                _filename: string | null,
                event: Record<string, unknown>,
              ) => {
                const kind = event.kind as string;
                // Everything the compiler reports that is not a success is a
                // function it is not optimizing, whatever it calls the reason.
                if (kind === "CompileSuccess") {
                  events.push({
                    file: file.relativePath,
                    name: describe(event),
                    compiled: true,
                  });
                } else if (
                  kind === "CompileError" ||
                  kind === "PipelineError"
                ) {
                  const detail = event.detail as
                    | { options?: { reason?: string }; reason?: string }
                    | undefined;
                  events.push({
                    file: file.relativePath,
                    name: describe(event),
                    compiled: false,
                    reason: detail?.options?.reason ?? detail?.reason,
                  });
                }
                // `CompileSkip` is the compiler declining to touch something
                // that is not a component or a hook, which is the normal
                // outcome for most of this graph.
              },
            },
          },
        ],
      ],
    });

    return events;
  };
  /* c8 ignore stop */
}

export function compileAll(
  files: SourceFile[],
  compile: Compiler,
): CompileEvent[] {
  return files.flatMap((file) => compile(file));
}

export function main(root: string, compile?: Compiler): number {
  const sources = collectSources(root);
  const clientGraph = collectClientGraph(sources);

  const configFiles: SourceFile[] = [CONFIG_FILE]
    .filter((relativePath) => existsSync(path.join(root, relativePath)))
    .map((relativePath) => ({
      relativePath,
      text: readFileSync(path.join(root, relativePath), "utf8"),
    }));

  const packageManifest = JSON.parse(
    readFileSync(path.join(root, PACKAGE_FILE), "utf8"),
  ) as PackageManifest;

  const events = compileAll(clientGraph, compile ?? createCompiler(root));

  const findings = [
    ...checkConfig(configFiles),
    ...checkBuildManifest(readBuildManifest(root)),
    ...checkPackages(packageManifest),
    ...checkCompilation(events),
    ...checkManualMemos(sources),
    ...checkOptOuts(sources),
  ];

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}  [${finding.rule}] ${finding.message}`);
    }
    console.error(
      `\nReact Compiler gate failed with ${findings.length} finding(s).`,
    );
    return 1;
  }

  const compiled = events.filter((event) => event.compiled).length;
  console.log(
    `React Compiler OK — enabled in ${CONFIG_FILE} and in the build that ` +
      `wrote ${SERVER_FILES_MANIFEST}; ${compiled} component(s) and hook(s) ` +
      `compiled across ${clientGraph.length} client-graph module(s) with no ` +
      "bail-outs; every surviving manual memo is justified.",
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
