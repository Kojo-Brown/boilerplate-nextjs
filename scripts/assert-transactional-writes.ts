/**
 * Asserts the two properties of `writeWithOutbox` that nothing at runtime
 * checks, and that no test can catch while `@/lib/prisma` is mocked.
 *
 *   T1  Inside a `writeWithOutbox` callback, the imported `prisma` singleton
 *       may not be used. The transaction client `tx` is the only client in
 *       scope that is *in* the transaction.
 *
 *   T2  The callback must bind its client as `tx`, and must bind it. A
 *       destructuring rename (`({ tx: db })`) or a bare `(context)` parameter
 *       would put a transaction client behind a name T1 does not recognise and
 *       `assert-cache-invalidation.ts` does not count as a write, which is two
 *       gates silently switched off by a rename.
 *
 *   T3  Only `@/lib/outbox` may write to the `outboxEvent` table. An event
 *       written anywhere else is a promise of an effect with nothing
 *       guaranteeing the write it describes — which is the failure the outbox
 *       exists to remove, reintroduced through the outbox itself.
 *
 * ## Why T1 needs a gate
 *
 * Because it is the defining bug of this pattern and it has no symptom.
 *
 *     await writeWithOutbox(async ({ tx, emit }) => {
 *       const post = await prisma.post.create({ … });   // ← wrong client
 *       emit({ type: "post.created", … });
 *     });
 *
 * That compiles. It passes every unit test, because the test mocks
 * `@/lib/prisma` and the transaction client the mock hands back *is* the same
 * object. It works in development, because nothing rolls back. What it does is
 * run the insert on a second connection, outside the transaction: it commits on
 * its own, it is invisible to the transaction's own later reads, and it
 * survives the rollback that was supposed to undo it. The outbox row and the
 * post row then have exactly the independent lifetimes the transaction was
 * introduced to remove.
 *
 * Type checking cannot see it. `prisma` and `tx` are both clients with the same
 * model methods, so using the wrong one is well-typed by construction — which
 * is why this is a syntactic rule rather than a type.
 *
 * Usage: tsx scripts/assert-transactional-writes.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** The helper that opens a transaction, by the name call sites import. */
const TRANSACTION_HELPER = "writeWithOutbox";

/** The name the transaction client must be bound to inside the callback. */
export const TRANSACTION_CLIENT_NAME = "tx";

/** The module whose export the singleton arrives as. */
const PRISMA_MODULE = "@/lib/prisma";

/** The Prisma delegate for the outbox table. */
const OUTBOX_DELEGATE = "outboxEvent";

/** Prisma methods that write. Reads of the outbox table are nobody's problem. */
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);

/**
 * The directory allowed to write outbox rows, and to be the one place that
 * knows how. Everything under it is the mechanism itself.
 */
const OUTBOX_MODULE_PREFIX = "src/lib/outbox/";

export interface Finding {
  rule: "T1" | "T2" | "T3";
  file: string;
  line: number;
  message: string;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
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

/** Every `writeWithOutbox(...)` call in a file. */
function transactionCalls(source: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === TRANSACTION_HELPER
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return calls;
}

/**
 * The callback argument of a `writeWithOutbox` call, if it has one written
 * inline.
 *
 * A call whose callback is a reference to a function declared elsewhere is
 * reported by T2 rather than skipped: this gate can only read what it can see,
 * and "the rule does not apply because the code moved" is the silent pass every
 * gate in this repository is shaped to refuse.
 */
function callbackOf(
  call: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const [first] = call.arguments;
  if (!first) return undefined;
  if (ts.isArrowFunction(first) || ts.isFunctionExpression(first)) return first;
  return undefined;
}

/** Whether a callback destructures its first parameter to a binding named `tx`. */
function bindsTransactionClient(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
  const [parameter] = callback.parameters;
  if (!parameter || !ts.isObjectBindingPattern(parameter.name)) return false;

  return parameter.name.elements.some(
    (element) =>
      ts.isIdentifier(element.name) &&
      element.name.text === TRANSACTION_CLIENT_NAME &&
      // `{ tx: other }` renames the client; `propertyName` is set only then.
      element.propertyName === undefined,
  );
}

/** Every `prisma` identifier used as a value inside a subtree. */
function prismaReferences(root: ts.Node): ts.Identifier[] {
  const found: ts.Identifier[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "prisma") {
      // Skip the property half of `something.prisma`, which is a different
      // symbol that happens to share the name.
      const parent = node.parent as ts.Node | undefined;
      const isPropertyName =
        parent !== undefined &&
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node;

      if (!isPropertyName) found.push(node);
    }
    ts.forEachChild(node, visit);
  };

  visit(root);
  return found;
}

/** Every write to the outbox delegate in a subtree: `<client>.outboxEvent.<write>()`. */
function outboxWrites(root: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WRITE_METHODS.has(node.expression.name.text) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === OUTBOX_DELEGATE
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };

  visit(root);
  return found;
}

export function checkSources(
  files: ReadonlyArray<{ relativePath: string; text: string }>,
): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    const source = ts.createSourceFile(
      file.relativePath,
      file.text,
      ts.ScriptTarget.ES2022,
      true,
      file.relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const usesSingleton = importsPrismaSingleton(source);

    for (const call of transactionCalls(source)) {
      const callback = callbackOf(call);

      if (!callback) {
        findings.push({
          rule: "T2",
          file: file.relativePath,
          line: lineOf(source, call),
          message:
            `calls ${TRANSACTION_HELPER} with a callback this gate cannot read. ` +
            `Write the callback inline as \`async ({ ${TRANSACTION_CLIENT_NAME}, emit }) => …\` — a callback ` +
            `declared elsewhere hides which client its writes use, which is the one thing T1 checks.`,
        });
        continue;
      }

      if (!bindsTransactionClient(callback)) {
        findings.push({
          rule: "T2",
          file: file.relativePath,
          line: lineOf(source, callback),
          message:
            `calls ${TRANSACTION_HELPER} with a callback that does not bind \`${TRANSACTION_CLIENT_NAME}\`. ` +
            `Destructure the context as \`{ ${TRANSACTION_CLIENT_NAME}, emit }\` without renaming: the name is what ` +
            `T1 and assert-cache-invalidation.ts recognise as the transaction client.`,
        });
      }

      // T1 — the singleton inside the callback. Only meaningful in a file that
      // imported it; a local variable named `prisma` in a file that did not is
      // somebody else's identifier.
      if (!usesSingleton) continue;

      for (const reference of prismaReferences(callback.body)) {
        findings.push({
          rule: "T1",
          file: file.relativePath,
          line: lineOf(source, reference),
          message:
            `uses the \`prisma\` singleton inside a ${TRANSACTION_HELPER} callback. That client is a ` +
            `different connection: the statement runs outside the transaction, commits on its own, and ` +
            `survives the rollback that was meant to undo it. Use \`${TRANSACTION_CLIENT_NAME}\`, or move the ` +
            `call outside the callback if it genuinely belongs outside the transaction.`,
        });
      }
    }

    // T3 — outbox writes outside the outbox module.
    if (file.relativePath.startsWith(OUTBOX_MODULE_PREFIX)) continue;

    for (const write of outboxWrites(source)) {
      findings.push({
        rule: "T3",
        file: file.relativePath,
        line: lineOf(source, write),
        message:
          `writes to the \`${OUTBOX_DELEGATE}\` table. Only ${OUTBOX_MODULE_PREFIX} may: an event written ` +
          `outside \`${TRANSACTION_HELPER}\` is not covered by the transaction that made it true, which is ` +
          `the entire property the outbox provides.`,
      });
    }
  }

  return findings;
}

/** Every `.ts`/`.tsx` file under `src/`, excluding tests. */
export function collectSources(
  root: string,
): Array<{ relativePath: string; text: string }> {
  const files: Array<{ relativePath: string; text: string }> = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }

      if (!/\.tsx?$/.test(entry.name)) continue;
      // Tests are excluded on purpose: they mock `@/lib/prisma`, so a reference
      // to `prisma` inside a callback there is a reference to the mock — the
      // thing being asserted about, not a connection.
      if (/\.test\.tsx?$/.test(entry.name)) continue;

      files.push({
        relativePath: path.relative(root, absolute).split(path.sep).join("/"),
        text: readFileSync(absolute, "utf8"),
      });
    }
  };

  walk(path.join(root, "src"));
  return files;
}

function main(): void {
  const root = process.cwd();
  const findings = checkSources(collectSources(root));

  if (findings.length > 0) {
    console.error(`\n${findings.length} transactional-write violation(s):\n`);
    for (const finding of findings) {
      console.error(`  ${finding.rule}  ${finding.file}:${finding.line}`);
      console.error(`      ${finding.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    "Transactional writes: every writeWithOutbox callback uses its own transaction client, " +
      "and the outbox table is written only by @/lib/outbox.",
  );
}

// Only when run directly, so the test can import `checkSources` without the
// walk and the exit code coming with it.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
