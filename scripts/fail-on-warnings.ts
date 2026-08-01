/**
 * Runs a command and fails the build if it printed a warning — even when the
 * command itself exited 0.
 *
 * Most of our gates already have a strict switch (`eslint --max-warnings 0`,
 * `pnpm install --strict-peer-dependencies`). `next build` and `vitest run` do
 * not: they print deprecation notices and keep going, so a warning introduced
 * on a Friday is still there a month later. This wrapper closes that gap by
 * reading the child's output and turning a match into a non-zero exit.
 *
 * Usage: tsx scripts/fail-on-warnings.ts <command> [...args]
 */
import { spawn } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

export interface DetectedWarning {
  /** 1-based line number within the captured output. */
  line: number;
  /** The offending line, with ANSI escapes removed. */
  text: string;
  /** Which tool's warning format matched. */
  kind: string;
}

/**
 * Only unambiguous, start-of-line markers live here. Matching a bare "warning"
 * anywhere in the output would fail on a route named `/warnings` or a test
 * title containing the word, and a gate that cries wolf gets switched off.
 */
const WARNING_MARKERS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  // `⚠ The "middleware" file convention is deprecated.`
  { kind: "next", pattern: /^\s*⚠/ },
  // ` DEPRECATED  "environmentMatchGlobs" is deprecated.`
  { kind: "vitest", pattern: /^\s*DEPRECATED\b/ },
  // `(node:1234) [DEP0040] DeprecationWarning: ...`
  { kind: "node", pattern: /^\(node:\d+\)\s+(?:\[[^\]]+\]\s+)?\w*Warning:/ },
  // `WARN  deprecated subdep@1.0.0` / `npm warn deprecated ...`
  { kind: "package-manager", pattern: /^\s*(?:WARN|npm warn)\b/ },
];

/**
 * Warnings that describe the CI environment rather than the code, and that no
 * change to this repository can remove. Keep this list as short as it can be —
 * every entry is a hole in the gate — and give each one a reason.
 */
const IGNORED_WARNINGS: ReadonlyArray<{ reason: string; pattern: RegExp }> = [
  {
    // `⚠ No build cache found. Please configure build caching for faster
    // rebuilds.` Next prints this only under CI, whenever `.next/cache` is
    // absent. The build job does restore that cache, so this fires on a cold
    // runner or an evicted key — it reports the state of the machine, not of
    // the source, and no edit here can prevent it.
    reason: "cold .next/cache on a CI runner; not fixable from this repo",
    pattern: /No build cache found/,
  },
];

// Colourised output would otherwise hide a `⚠` behind a leading escape
// sequence. The escape is spelled as a unicode escape rather than embedded as
// a literal control byte, so the source survives editors and formatters.
const ANSI_ESCAPE = /\u001B\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

export function findWarnings(output: string): DetectedWarning[] {
  const warnings: DetectedWarning[] = [];

  output.split("\n").forEach((rawLine, index) => {
    const text = stripAnsi(rawLine).trimEnd();
    const marker = WARNING_MARKERS.find(({ pattern }) => pattern.test(text));
    if (!marker) return;
    if (IGNORED_WARNINGS.some(({ pattern }) => pattern.test(text))) return;
    warnings.push({ line: index + 1, text: text.trim(), kind: marker.kind });
  });

  return warnings;
}

export interface RunOptions {
  /**
   * Mirror the child's output to this process's stdio. On by default, because
   * a CI log that swallowed the build output would be useless. Tests turn it
   * off: their fixtures print warning-shaped lines on purpose, and echoing
   * those would trip the very gate that wraps the test run.
   */
  echo?: boolean;
}

/**
 * Runs `command` and resolves with its exit code plus everything it wrote to
 * stdout and stderr.
 */
export function runCapturing(
  command: string,
  args: readonly string[],
  { echo = true }: RunOptions = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["inherit", "pipe", "pipe"],
      // `pnpm`/`next` are shell scripts on Windows; on POSIX this is a no-op.
      shell: process.platform === "win32",
    });

    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (echo) process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (echo) process.stderr.write(chunk);
    });

    child.on("error", reject);
    // A signal death has no exit code; report it as a failure rather than 0.
    child.on("close", (code, signal) =>
      resolve({ code: code ?? (signal ? 1 : 0), output }),
    );
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command) {
    process.stderr.write(
      "usage: tsx scripts/fail-on-warnings.ts <command> [...args]\n",
    );
    process.exitCode = 2;
    return;
  }

  const { code, output } = await runCapturing(command, args);

  // The command's own failure is the more useful signal — report that first
  // and leave warning triage for a run that gets past it.
  if (code !== 0) {
    process.exitCode = code;
    return;
  }

  const warnings = findWarnings(output);
  if (warnings.length === 0) {
    return;
  }

  process.stderr.write(
    `\n${warnings.length} warning(s) found in the output of \`${[command, ...args].join(" ")}\`:\n`,
  );
  for (const warning of warnings) {
    process.stderr.write(
      `  [${warning.kind}] line ${warning.line}: ${warning.text}\n`,
    );
  }
  process.stderr.write(
    "\nFix the warning at its source. If it is genuinely unactionable, narrow\n" +
      "WARNING_MARKERS in scripts/fail-on-warnings.ts and say why in the PR.\n",
  );
  process.exitCode = 1;
}

// `import.meta.main` is Node 24+; comparing argv[1] works on 22 as well, and
// keeps this file importable from the test suite without spawning anything.
const entrypoint = process.argv[1];
const invokedDirectly =
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href;

if (invokedDirectly) {
  // Not top-level `await`: tsx compiles this file to CJS (the package has no
  // `"type": "module"`), where top-level await is a hard error.
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
