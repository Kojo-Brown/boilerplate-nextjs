/**
 * Asserts the structural properties that keep one render from issuing the same
 * query more than once, and from issuing one query per row.
 *
 *   N1  No Prisma delegate access under `src/app/` or `src/components/`. A
 *       query written inside a component is a query no other component can
 *       share, because that is what a component is.
 *
 *   N2  An exported function in `src/lib/dal/` that touches `prisma` must be
 *       declared through `requestMemo`. An unmemoised read is one that runs
 *       once per caller.
 *
 *   N3  No `.map(async …)` whose callback awaits a data-layer read. That is
 *       the literal N+1: one statement per row, written as a loop.
 *
 *   N4  Every parameter of a memoised function must be a primitive. React keys
 *       the memo on argument identity, so an object argument misses every time
 *       and the memoisation is decorative.
 *
 *   N5  Every use of `.uncached` must carry a comment. It opts one call out of
 *       the deduplication, which is right in exactly one situation and silent
 *       when it is wrong.
 *
 *   N6  `createBatchLoader` may only be called in `src/lib/dal/loaders.ts`.
 *
 *   N7  …and only from inside a function body.
 *
 * ## Why any of this needs a gate
 *
 * Because the defect has no symptom. Every query involved is correct, fast, and
 * indexed; the page renders the right thing; nothing errors and no test fails.
 * The only evidence is in the database's statement log, which nothing in CI
 * reads. This application served `/dashboard` with five statements against
 * `posts` for one user — `@stats` counting posts and published posts,
 * `@notifications` counting drafts and reading the last edited row, `@activity`
 * reading the five newest — and seven decodes of the same session cookie. Each of
 * the five was a reasonable thing for the component that wrote it to do.
 *
 * That is what makes it structural rather than a matter of care. Parallel
 * routes and Suspense boundaries render independently — that is the property
 * they exist for — so no component can see what another has already asked for.
 * The only place two of them can share a read is a layer above both, and the
 * rules here are what keep reads in it.
 *
 * N4 exists because the fix has a failure mode that looks exactly like the fix.
 * `cache` compares arguments with `SameValueZero`, so a read wrapped in
 * `requestMemo` and called as `find({ userId })` builds a new object at every
 * call site, misses every time, and runs once per caller — memoised in the
 * source and unmemoised in production.
 *
 * Static analysis, so it needs no build output and no database.
 *
 * Usage: tsx scripts/assert-no-n-plus-one.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** The module the Prisma singleton arrives from. */
const PRISMA_MODULE = "@/lib/prisma";

/** The memoisation wrapper, by the name call sites import. */
const MEMO_HELPER = "requestMemo";

/** The property that opts a call out of memoisation. */
const UNCACHED_PROPERTY = "uncached";

/** The batch loader factory. */
const BATCH_FACTORY = "createBatchLoader";

/** The one module allowed to build loader instances. */
const LOADERS_MODULE = "src/lib/dal/loaders.ts";

/** Where render-path code lives. Nothing here may talk to Prisma. */
const RENDER_PREFIXES = ["src/app/", "src/components/"] as const;

/** The data-access layer. */
const DAL_PREFIX = "src/lib/dal/";

/**
 * Prisma delegate methods. Reads and writes both: a component has no business
 * doing either, and listing only reads would let `prisma.post.update()` in a
 * server component pass a gate whose whole subject is where data access lives.
 */
const DELEGATE_METHODS = new Set([
  "aggregate",
  "count",
  "create",
  "createMany",
  "createManyAndReturn",
  "delete",
  "deleteMany",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);

/**
 * Reads that are exempt from N2, with the reason.
 *
 * Both take a `CursorPageParams` object, so `cache` would compare a fresh
 * object literal against the last one and miss on every call — memoisation
 * that costs a `Map` entry and saves nothing. They are also called once per
 * request each, from a route handler rather than from a component tree, so
 * there is no second caller to share with. Making them memoisable would mean
 * flattening the cursor into positional primitives, which is a worse signature
 * for the sake of a gate.
 */
const N2_EXEMPT = new Map<string, string>([
  [
    "getPaginatedPostsByUser",
    "takes a cursor object; `cache` keys on argument identity, so a memo could never hit",
  ],
  [
    "getPaginatedPublishedPosts",
    "takes a cursor object; `cache` keys on argument identity, so a memo could never hit",
  ],
]);

export type Rule = "N1" | "N2" | "N3" | "N4" | "N5" | "N6" | "N7";

export interface Finding {
  rule: Rule;
  file: string;
  line: number;
  message: string;
}

export interface SourceFileInput {
  relativePath: string;
  text: string;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Whether a file imports `prisma` from `@/lib/prisma`. */
function importsPrismaSingleton(source: ts.SourceFile): boolean {
  return source.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== PRISMA_MODULE
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return false;
    return bindings.elements.some(
      (element) => (element.propertyName ?? element.name).text === "prisma",
    );
  });
}

/** Names imported from any `@/lib/dal/…` module. */
function dalImportNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith("@/lib/dal/")
    ) {
      continue;
    }
    // Type-only imports are erased; they cannot issue a query.
    if (statement.importClause?.isTypeOnly) continue;

    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        names.add(element.name.text);
      }
    }
  }

  return names;
}

/** Every `prisma.<model>.<delegateMethod>(…)` call in a file. */
function delegateCalls(source: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];

  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;

    // prisma.<model>.<method>
    const method = node.expression;
    if (!ts.isPropertyAccessExpression(method)) return;
    if (!DELEGATE_METHODS.has(method.name.text)) return;

    const model = method.expression;
    if (!ts.isPropertyAccessExpression(model)) return;
    if (!ts.isIdentifier(model.expression)) return;
    if (model.expression.text !== "prisma") return;

    calls.push(node);
  });

  return calls;
}

/** Whether a node's subtree mentions `prisma.<something>`. */
function touchesPrisma(node: ts.Node): boolean {
  let found = false;
  walk(node, (child) => {
    if (
      ts.isPropertyAccessExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === "prisma"
    ) {
      found = true;
    }
  });
  return found;
}

/** Whether a call is `requestMemo(...)`. */
function isMemoCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === MEMO_HELPER
  );
}

/**
 * A parameter type that `cache` can compare by value.
 *
 * Primitives, unions of them, and unions with literal members — a role enum
 * spelled `"USER" | "ADMIN"` is as safe a memo key as a `string`.
 */
function isPrimitiveTypeNode(type: ts.TypeNode | undefined): boolean {
  if (!type) return false;

  switch (type.kind) {
    case ts.SyntaxKind.StringKeyword:
    case ts.SyntaxKind.NumberKeyword:
    case ts.SyntaxKind.BooleanKeyword:
    case ts.SyntaxKind.BigIntKeyword:
    case ts.SyntaxKind.UndefinedKeyword:
    case ts.SyntaxKind.NullKeyword:
      return true;
    default:
      break;
  }

  if (ts.isLiteralTypeNode(type)) return true;
  if (ts.isUnionTypeNode(type)) return type.types.every(isPrimitiveTypeNode);

  return false;
}

/** Whether the statement a node sits in carries a leading comment. */
function hasLeadingComment(source: ts.SourceFile, node: ts.Node): boolean {
  let statement: ts.Node | undefined = node;
  while (statement && !ts.isStatement(statement)) {
    statement = statement.parent;
  }
  if (!statement) return false;

  const ranges = ts.getLeadingCommentRanges(
    source.getFullText(),
    statement.getFullStart(),
  );
  return (ranges?.length ?? 0) > 0;
}

/** Whether a node has a function between it and the file. */
function isInsideFunction(node: ts.Node): boolean {
  let parent = node.parent;
  while (parent) {
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isMethodDeclaration(parent)
    ) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

function isRenderPath(relativePath: string): boolean {
  return RENDER_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

export function checkSources(files: readonly SourceFileInput[]): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    const source = ts.createSourceFile(
      file.relativePath,
      file.text,
      ts.ScriptTarget.Latest,
      true,
      file.relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    // ── N1 — Prisma in the render path ────────────────────────────────────
    if (isRenderPath(file.relativePath) && importsPrismaSingleton(source)) {
      for (const call of delegateCalls(source)) {
        findings.push({
          rule: "N1",
          file: file.relativePath,
          line: lineOf(source, call),
          message:
            `queries Prisma from a component. Nothing else in the render can see this read, so a ` +
            `sibling that needs the same rows issues its own — which is how one /dashboard request ` +
            `came to run five statements against \`posts\` for one user. Move it into ${DAL_PREFIX} ` +
            `and wrap it in \`${MEMO_HELPER}\`.`,
        });
      }
    }

    // ── N2 / N4 — the data layer ──────────────────────────────────────────
    //
    // `loaders.ts` is excluded because it is the deduplication rather than a
    // consumer of it. Its exports are factories: the `prisma.findMany` in one
    // is the loader's `fetch`, which by construction runs once per batch, and
    // memoising the factory would memoise the *instance* — a loader shared
    // between requests, which is the leak N7 exists to prevent. N6 and N7
    // govern this module instead.
    if (
      file.relativePath.startsWith(DAL_PREFIX) &&
      file.relativePath !== LOADERS_MODULE
    ) {
      for (const statement of source.statements) {
        if (
          !ts.isVariableStatement(statement) &&
          !ts.isFunctionDeclaration(statement)
        ) {
          continue;
        }
        const exported = statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        );
        if (!exported) continue;

        // An exported `function` that touches Prisma cannot have been memoised
        // — `requestMemo` returns a value, so a memoised read is a `const`.
        if (ts.isFunctionDeclaration(statement)) {
          const name = statement.name?.text ?? "<anonymous>";
          if (
            statement.body &&
            touchesPrisma(statement.body) &&
            !N2_EXEMPT.has(name)
          ) {
            findings.push({
              rule: "N2",
              file: file.relativePath,
              line: lineOf(source, statement),
              message:
                `\`${name}\` reads through Prisma but is not memoised. Two components asking for the ` +
                `same rows in one request will issue two statements. Declare it as ` +
                `\`export const ${name} = ${MEMO_HELPER}(async (…) => …)\`, or add it to N2_EXEMPT with ` +
                `the reason it cannot be.`,
            });
          }
          continue;
        }

        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          const name = declaration.name.text;
          const initializer = declaration.initializer;
          if (!initializer) continue;

          if (isMemoCall(initializer)) {
            // N4 — the memo has to be able to hit.
            const [wrapped] = initializer.arguments;
            if (
              wrapped &&
              (ts.isArrowFunction(wrapped) || ts.isFunctionExpression(wrapped))
            ) {
              for (const parameter of wrapped.parameters) {
                if (isPrimitiveTypeNode(parameter.type)) continue;
                findings.push({
                  rule: "N4",
                  file: file.relativePath,
                  line: lineOf(source, parameter),
                  message:
                    `\`${name}\` is memoised but takes a non-primitive parameter. React compares memo ` +
                    `arguments with SameValueZero, so a fresh object at each call site misses every ` +
                    `time and the read runs once per caller — memoised in the source and not in ` +
                    `production. Take primitives, or drop the ${MEMO_HELPER} and say why.`,
                });
              }
            }
            continue;
          }

          if (touchesPrisma(initializer) && !N2_EXEMPT.has(name)) {
            findings.push({
              rule: "N2",
              file: file.relativePath,
              line: lineOf(source, declaration),
              message:
                `\`${name}\` reads through Prisma but is not wrapped in \`${MEMO_HELPER}\`. Two ` +
                `components asking for the same rows in one request will issue two statements.`,
            });
          }
        }
      }
    }

    // ── N3 — a query per row ──────────────────────────────────────────────
    if (isRenderPath(file.relativePath)) {
      const dalNames = dalImportNames(source);

      walk(source, (node) => {
        if (!ts.isCallExpression(node)) return;
        if (!ts.isPropertyAccessExpression(node.expression)) return;
        if (node.expression.name.text !== "map") return;

        const [callback] = node.arguments;
        if (
          !callback ||
          !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        ) {
          return;
        }
        const isAsync = callback.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
        );
        if (!isAsync) return;

        let awaitsDalRead: ts.Node | null = null;
        walk(callback.body, (child) => {
          if (awaitsDalRead) return;
          if (!ts.isCallExpression(child)) return;
          const callee = child.expression;
          const calleeName = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee)
              ? callee.name.text
              : null;
          if (calleeName && dalNames.has(calleeName)) awaitsDalRead = child;
        });

        if (awaitsDalRead) {
          findings.push({
            rule: "N3",
            file: file.relativePath,
            line: lineOf(source, node),
            message:
              `maps rows onto a data-layer read, which is one statement per row. Read the relation ` +
              `with the list — every list read in ${DAL_PREFIX} pulls its author through \`select\` — ` +
              `or collect the ids and use \`loadMany\`, which issues one \`… WHERE "id" IN (…)\`.`,
          });
        }
      });
    }

    // ── N5 — every opt-out is deliberate ──────────────────────────────────
    walk(source, (node) => {
      if (!ts.isPropertyAccessExpression(node)) return;
      if (node.name.text !== UNCACHED_PROPERTY) return;
      if (hasLeadingComment(source, node)) return;

      findings.push({
        rule: "N5",
        file: file.relativePath,
        line: lineOf(source, node),
        message:
          `uses \`.${UNCACHED_PROPERTY}\` with no comment saying why. It opts one call out of ` +
          `request deduplication, which is correct for a read that follows a write in the same ` +
          `request and is otherwise a query issued twice on purpose.`,
      });
    });

    // ── N6 / N7 — where loaders may be built ──────────────────────────────
    walk(source, (node) => {
      if (
        !ts.isCallExpression(node) ||
        !ts.isIdentifier(node.expression) ||
        node.expression.text !== BATCH_FACTORY
      ) {
        return;
      }

      if (file.relativePath !== LOADERS_MODULE) {
        findings.push({
          rule: "N6",
          file: file.relativePath,
          line: lineOf(source, node),
          message:
            `calls \`${BATCH_FACTORY}\` outside ${LOADERS_MODULE}. A loader is a cache of rows with no ` +
            `expiry, which is safe for the length of a request and a cross-user data leak for the ` +
            `length of a process. Keeping every instance behind a \`cache()\` call in one module is ` +
            `what makes that lifetime checkable.`,
        });
        return;
      }

      if (!isInsideFunction(node)) {
        findings.push({
          rule: "N7",
          file: file.relativePath,
          line: lineOf(source, node),
          message:
            `builds a loader at module scope. That instance lives as long as the process and is ` +
            `shared by every request it serves, so the first request's rows are returned to all of ` +
            `them — across users. Build it inside a factory and reach it through \`cache(factory)\`.`,
        });
      }
    });
  }

  return findings;
}

/** Every `.ts`/`.tsx` file under `src/`, excluding tests. */
export function collectSources(root: string): SourceFileInput[] {
  const files: SourceFileInput[] = [];

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }

      if (!/\.tsx?$/.test(entry.name)) continue;
      // Tests mock `@/lib/prisma`, so a delegate call in one is an assertion
      // about a mock rather than a statement against a database.
      if (/\.test\.tsx?$/.test(entry.name)) continue;

      files.push({
        relativePath: path.relative(root, absolute).split(path.sep).join("/"),
        text: readFileSync(absolute, "utf8"),
      });
    }
  };

  visit(path.join(root, "src"));
  return files;
}

function main(): void {
  const findings = checkSources(collectSources(process.cwd()));

  if (findings.length > 0) {
    console.error(`\n${findings.length} N+1 violation(s):\n`);
    for (const finding of findings) {
      console.error(`  ${finding.rule}  ${finding.file}:${finding.line}`);
      console.error(`      ${finding.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    "N+1: data access stays in the data layer, every read there is request-scoped, " +
      "and no list maps rows onto a query.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
