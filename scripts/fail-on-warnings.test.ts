import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { findWarnings, stripAnsi, runCapturing } from "./fail-on-warnings";

const SCRIPT = fileURLToPath(new URL("./fail-on-warnings.ts", import.meta.url));
const ESC = "\u001B";

/**
 * Runs the wrapper itself, the way CI does, and reports how it exited.
 *
 * `echo: false` matters here: several fixtures below print warning-shaped
 * lines, and CI runs this very suite under the wrapper. Mirroring them would
 * make the suite fail its own gate.
 */
function runWrapper(...args: string[]) {
  return runCapturing("node", ["--import", "tsx", SCRIPT, ...args], {
    echo: false,
  });
}

describe("stripAnsi", () => {
  it("removes colour codes", () => {
    expect(stripAnsi(`${ESC}[33m⚠ deprecated${ESC}[39m`)).toBe("⚠ deprecated");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("nothing to strip")).toBe("nothing to strip");
  });

  it("does not eat bracketed text that is not an escape sequence", () => {
    expect(stripAnsi("[info] all good")).toBe("[info] all good");
  });
});

describe("findWarnings", () => {
  it("returns nothing for clean output", () => {
    expect(findWarnings("✓ Compiled successfully\nRoute (app)\n")).toEqual([]);
  });

  it("catches the Next.js warning glyph", () => {
    const warnings = findWarnings(
      '  Creating an optimized production build ...\n⚠ The "middleware" file convention is deprecated.\n',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ kind: "next", line: 2 });
    expect(warnings[0]?.text).toContain("deprecated");
  });

  it("catches a Next.js warning behind ANSI colour codes", () => {
    const warnings = findWarnings(`${ESC}[33m⚠ something is off${ESC}[39m`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.kind).toBe("next");
  });

  it("catches Vitest deprecation banners", () => {
    const warnings = findWarnings(
      ' DEPRECATED  "environmentMatchGlobs" is deprecated.\n',
    );
    expect(warnings[0]?.kind).toBe("vitest");
  });

  it("catches Node process warnings, with or without a DEP code", () => {
    const warnings = findWarnings(
      "(node:1234) [DEP0040] DeprecationWarning: punycode is deprecated\n" +
        "(node:1234) Warning: something happened\n",
    );
    expect(warnings.map((w) => w.kind)).toEqual(["node", "node"]);
  });

  it("catches package-manager warnings", () => {
    const warnings = findWarnings(
      " WARN  deprecated fake-package@0.0.1\nnpm warn deprecated other@1.0.0\n",
    );
    expect(warnings.map((w) => w.kind)).toEqual([
      "package-manager",
      "package-manager",
    ]);
  });

  it("reports every warning, not just the first", () => {
    expect(findWarnings("⚠ one\nfine\n⚠ two\n")).toHaveLength(2);
  });

  it("ignores the word 'warning' in ordinary prose", () => {
    const output = [
      "Route (app)",
      "├ ƒ /warnings",
      "✓ renders a warning banner",
      "these are not warnings: WARNING_MARKERS",
    ].join("\n");
    expect(findWarnings(output)).toEqual([]);
  });

  it("ignores the cold-build-cache notice, which describes the runner", () => {
    expect(
      findWarnings(
        "⚠ No build cache found. Please configure build caching for faster rebuilds. Read more: https://nextjs.org/docs/messages/no-cache\n",
      ),
    ).toEqual([]);
  });

  it("still catches a real warning printed alongside an ignored one", () => {
    const warnings = findWarnings(
      "⚠ No build cache found. Please configure build caching for faster rebuilds.\n" +
        '⚠ The "middleware" file convention is deprecated.\n',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.text).toContain("middleware");
  });

  it("reports 1-based line numbers", () => {
    expect(findWarnings("a\nb\n⚠ third line\n")[0]?.line).toBe(3);
  });
});

describe("fail-on-warnings CLI", () => {
  it("passes through a clean command's success", async () => {
    const { code } = await runWrapper("node", "-e", "console.log('all good')");
    expect(code).toBe(0);
  });

  it("fails when the wrapped command printed a warning but exited 0", async () => {
    const { code, output } = await runWrapper(
      "node",
      "-e",
      "console.log('⚠ deprecated thing'); process.exit(0)",
    );
    expect(code).toBe(1);
    expect(output).toContain("1 warning(s) found");
    expect(output).toContain("[next]");
  });

  it("propagates the wrapped command's own exit code", async () => {
    const { code } = await runWrapper("node", "-e", "process.exit(3)");
    expect(code).toBe(3);
  });

  it("prefers the command's exit code over warning triage", async () => {
    const { code, output } = await runWrapper(
      "node",
      "-e",
      "console.log('⚠ noisy'); process.exit(2)",
    );
    expect(code).toBe(2);
    expect(output).not.toContain("warning(s) found");
  });

  it("exits 2 when given no command", async () => {
    const { code, output } = await runWrapper();
    expect(code).toBe(2);
    expect(output).toContain("usage:");
  });

  it("mirrors the wrapped command's output", async () => {
    const { output } = await runWrapper(
      "node",
      "-e",
      "console.log('hello ci')",
    );
    expect(output).toContain("hello ci");
  });
}, 60_000);
