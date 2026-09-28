import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  check,
  withoutLineComments,
  sourceFiles,
  CONSOLE_EXCEPTIONS,
  ESLINT_CONFIG,
  LOGGER_FILE,
  REDACT_FILE,
  PRINTABLE_FIXTURES,
  secretFixtures,
} from "./assert-log-redaction";

const REPO = process.cwd();

/**
 * A copy of the real sources, broken in one specific way.
 *
 * Copying the tree rather than writing fixtures is what makes each case below a
 * statement about *this* repository: the gate has to pass as it stands and fail
 * with one line changed. A hand-written fixture would only prove that a regex
 * matches a string somebody wrote to make it match.
 */
function withBrokenTree(
  edits: { file: string; edit: (source: string) => string }[],
): string {
  const root = mkdtempSync(path.join(tmpdir(), "log-redaction-gate-"));
  cpSync(path.join(REPO, "src"), path.join(root, "src"), { recursive: true });
  cpSync(path.join(REPO, ESLINT_CONFIG), path.join(root, ESLINT_CONFIG));

  for (const { file, edit } of edits) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    const before = readFileSync(target, "utf8");
    const after = edit(before);
    if (after === before)
      throw new Error(`the edit to ${file} changed nothing`);
    writeFileSync(target, after, "utf8");
  }

  return root;
}

async function rulesFiring(
  edits: { file: string; edit: (source: string) => string }[],
): Promise<string[]> {
  const findings = await check(withBrokenTree(edits));
  return [...new Set(findings.map((finding) => finding.rule))];
}

describe("assert-log-redaction", () => {
  it("passes against the repository as it stands", async () => {
    expect(await check(REPO)).toEqual([]);
  });

  it("R1 — fails a console call added anywhere in src/", async () => {
    // The regression this whole gate exists for, and the one that looks like
    // every other line in a review: one `console.error` in a `catch`.
    const rules = await rulesFiring([
      {
        file: "src/lib/actions/define-action.ts",
        edit: (source) =>
          source.replace(
            "return err(UNEXPECTED_ERROR_MESSAGE);",
            'console.error("boom", thrown);\n    return err(UNEXPECTED_ERROR_MESSAGE);',
          ),
      },
    ]);
    expect(rules).toContain("R1");
  });

  it("R1 — fails the globalThis and process.stdout spellings too", async () => {
    // A ban on the obvious spelling is a ban on the obvious spelling.
    for (const call of [
      'globalThis.console.log("x");',
      'process.stdout.write("x");',
    ]) {
      const rules = await rulesFiring([
        {
          file: "src/lib/outbox/store.ts",
          edit: (source) => `${call}\n${source}`,
        },
      ]);
      expect(rules).toContain("R1");
    }
  });

  it("R1 — is not satisfied by a file that only mentions console in prose", async () => {
    // Both logging modules discuss `console.error` at length; a gate that
    // matched its own documentation would be unusable here.
    const rules = await rulesFiring([
      {
        file: "src/lib/outbox/store.ts",
        edit: (source) => `// console.error(secret)\n${source}`,
      },
    ]);
    expect(rules).not.toContain("R1");
  });

  it('R2 — fails an error boundary that stops declaring "use client"', async () => {
    // The argument for every entry on that list is that its output reaches one
    // browser's console. On a server the same line is a collected stream.
    const rules = await rulesFiring([
      {
        file: "src/app/blog/error.tsx",
        edit: (source) => source.replace('"use client";', ""),
      },
    ]);
    expect(rules).toContain("R2");
  });

  it("R2 — fails the client env module if it reaches for a server secret", async () => {
    // Its permission does not rest on a directive — it has none — but on the
    // schema it validates containing nothing secret. So that is what is
    // checked, in both spellings the module could lose it in.
    for (const edit of [
      (source: string) => `import "server-only";\n${source}`,
      (source: string) =>
        source.replace(
          'process.env["NEXT_PUBLIC_APP_URL"]',
          'process.env["NEXTAUTH_SECRET"]',
        ),
    ]) {
      const rules = await rulesFiring([
        { file: "src/lib/env/client.ts", edit },
      ]);
      expect(rules).toContain("R2");
    }
  });

  it("R3 — fails an exception that no longer writes to the console", async () => {
    const rules = await rulesFiring([
      {
        file: "src/app/blog/error.tsx",
        edit: (source) =>
          source.replace("console.error(error);", "void error;"),
      },
    ]);
    expect(rules).toContain("R3");
  });

  it("R4 — fails when the lint rule is switched off", async () => {
    // The layer that catches this in an editor. Losing it leaves one gate, run
    // once per push, against a mistake that is made once per branch.
    const rules = await rulesFiring([
      {
        file: ESLINT_CONFIG,
        edit: (source) =>
          source.replace('"no-console": "error"', '"no-console": "off"'),
      },
    ]);
    expect(rules).toContain("R4");
  });

  it("R4 — fails when the two layers disagree about an exception", async () => {
    const rules = await rulesFiring([
      {
        file: ESLINT_CONFIG,
        edit: (source) =>
          source.replace('"src/lib/env/client.ts",', '"src/lib/env/other.ts",'),
      },
    ]);
    expect(rules).toContain("R4");
  });

  it("R5 — fails when the writer stops redacting", async () => {
    // Every other rule funnels this application's log lines into one module.
    // This is the edit that makes that module print them unchecked, and it is
    // one line inside a file the rest of the gate is busy protecting.
    const rules = await rulesFiring([
      {
        file: LOGGER_FILE,
        edit: (source) =>
          source
            .replace('import { serialise } from "@/lib/logging/redact";', "")
            .replace(/serialise\(/g, "JSON.stringify("),
      },
    ]);
    expect(rules).toContain("R5");
  });

  it("R5 — fails a writer that imports the redactor and does not call it", async () => {
    const rules = await rulesFiring([
      {
        file: LOGGER_FILE,
        edit: (source) => source.replace(/serialise\(/g, "JSON.stringify("),
      },
    ]);
    expect(rules).toContain("R5");
  });

  it("R6 — fails a module that redacts its own line and writes it elsewhere", async () => {
    const rules = await rulesFiring([
      {
        file: "src/lib/outbox/store.ts",
        edit: (source) =>
          `import { serialise } from "@/lib/logging/redact";\n${source}`,
      },
    ]);
    expect(rules).toContain("R6");
  });

  it("P1 — fails when a secret format stops being refused", async () => {
    // Deleting one pattern. Nothing else in this repository notices: the unit
    // suite for the module that mints that format still passes, and so does
    // every test of every module that logs.
    const rules = await rulesFiring([
      {
        file: REDACT_FILE,
        edit: (source) =>
          source
            .replace('["phc-hash", PHC_HASH],', "")
            .replace('["jwt", JWT],', ""),
      },
    ]);
    expect(rules).toContain("P1");
  });

  it("P2 — fails when the redactor starts eating identifiers", async () => {
    // The failure that is not a leak. Dropping the identifier exclusion makes
    // the redactor strictly safer and the audit trail useless, and nothing
    // about a stricter redactor looks like a regression in review.
    const rules = await rulesFiring([
      {
        file: REDACT_FILE,
        edit: (source) =>
          source.replace("if (IDENTIFIER.test(value)) return false;", ""),
      },
    ]);
    expect(rules).toContain("P2");
  });

  it("P3 — fails when the whole-value patterns lose their anchors", async () => {
    // This one was a real bug before it was a rule: unanchored, a 600-character
    // driver message that mentions a hash classifies as a hash, and the whole
    // message is replaced by one marker.
    const rules = await rulesFiring([
      {
        file: REDACT_FILE,
        edit: (source) =>
          source.replace(
            'new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace("g", "")),',
            'new RegExp(pattern.source, pattern.flags.replace("g", "")),',
          ),
      },
    ]);
    expect(rules).toContain("P3");
  });

  it("P4 — fails when a throwing getter is no longer contained", async () => {
    // A log line is written from a `catch` block in every interesting case, so
    // reading a property that raises must not raise. Losing the guard loses
    // the whole line and not just that field: `serialise` falls back to a
    // two-key notice, and what it drops is the explanation the `catch` block
    // existed to record.
    const rules = await rulesFiring([
      {
        file: REDACT_FILE,
        edit: (source) =>
          source.replace(
            /    try \{\n      entries\.push\(\[key, \(object as Record<string, unknown>\)\[key\]\]\);\n    \} catch \(thrown\) \{[\s\S]*?\n    \}\n/,
            "    entries.push([key, (object as Record<string, unknown>)[key]]);\n",
          ),
      },
    ]);
    expect(rules).toContain("P4");
  });
});

describe("the fixtures the probes use", () => {
  it("mints a fresh hash rather than reusing a pasted one", () => {
    // A pasted fixture is a string somebody chose. What P1 has to check is the
    // format the password module produces today.
    expect(secretFixtures().passwordHash).not.toBe(
      secretFixtures().passwordHash,
    );
    expect(secretFixtures().passwordHash).toMatch(
      /^\$scrypt\$ln=\d+,r=\d+,p=\d+\$/,
    );
  });

  it("keeps the two halves disjoint", () => {
    // A value in both tables would make one of the two rules unfalsifiable.
    const printable = new Set(Object.values(PRINTABLE_FIXTURES));
    for (const secret of Object.values(secretFixtures())) {
      expect(printable.has(secret)).toBe(false);
    }
  });
});

describe("withoutLineComments", () => {
  it("leaves a glob alone, which a block-comment stripper does not", () => {
    // `"src/app/**` + `/error.tsx"` contains a complete block comment to any
    // stripper that does not parse string literals. Stripping it deleted the
    // globs R4 reads and reported eight exempted files as unexempted.
    const line = 'files: ["src/app/**/error.tsx"],';
    expect(withoutLineComments(line)).toBe(line);
  });

  it("still removes a commented-out rule", () => {
    expect(withoutLineComments('// "no-console": "error"')).toBe("");
  });
});

describe("sourceFiles", () => {
  it("skips tests, which spy on the console by design", () => {
    const files = sourceFiles(REPO);
    expect(files.some((file) => file.endsWith(".test.ts"))).toBe(false);
    expect(files).toContain(LOGGER_FILE);
  });

  it("covers every file the exception list names", () => {
    const files = new Set(sourceFiles(REPO));
    for (const entry of CONSOLE_EXCEPTIONS) {
      expect(files.has(entry.file)).toBe(true);
    }
  });
});
