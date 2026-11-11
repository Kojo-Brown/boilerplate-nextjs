/**
 * Asserts that every state the visual journey photographs has a committed
 * baseline, and that every committed baseline belongs to a state.
 *
 * Playwright covers the first half badly and the second half not at all. A
 * missing baseline fails the run that needs it — but only on the machine that
 * runs that project, only after a build, a database and a browser, and with a
 * message about one file. An **orphaned** baseline is invisible: a step renamed
 * or deleted leaves its `.png` behind for ever, and nothing ever opens it
 * again. That is the same failure the accessibility gate reports as a stale
 * allowance, for the same reason — an artefact nobody checks is one more thing
 * a reader has to assume is current.
 *
 * It is static: no browser, no server, no database. It reads the journey
 * registry and the directory, which is why it can run beside the cheap gates
 * rather than inside the end-to-end job.
 *
 * Usage: tsx scripts/assert-visual-baselines.ts [path-to-e2e/__screenshots__]
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  JOURNEY,
  PROJECT_FOR_SURFACE,
  SURFACES,
} from "../e2e/support/journey.js";

/** Mirrors `snapshotPathTemplate` in `playwright.config.ts`. */
export const BASELINE_DIR = path.join("e2e", "__screenshots__");

export interface Baseline {
  /** The Playwright project, which is also the directory name. */
  readonly project: string;
  /** The journey step's id, which is also the file's stem. */
  readonly step: string;
}

const key = (baseline: Baseline): string =>
  `${baseline.project}/${baseline.step}.png`;

/** Every image the visual suite will ask for, derived from the registry. */
export function expectedBaselines(): readonly Baseline[] {
  return SURFACES.flatMap((surface) =>
    JOURNEY.filter((step) => step.surfaces.includes(surface)).map((step) => ({
      project: PROJECT_FOR_SURFACE[surface],
      step: step.id,
    })),
  );
}

/** Every image on disk, under any project directory. */
export function presentBaselines(root: string): readonly Baseline[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => statSync(path.join(root, entry)).isDirectory())
    .flatMap((project) =>
      readdirSync(path.join(root, project))
        .filter((file) => file.endsWith(".png"))
        .map((file) => ({ project, step: file.slice(0, -".png".length) })),
    );
}

export interface BaselineReport {
  readonly missing: readonly Baseline[];
  readonly orphaned: readonly Baseline[];
  readonly matched: number;
}

export function compareBaselines(
  expected: readonly Baseline[],
  present: readonly Baseline[],
): BaselineReport {
  const presentKeys = new Set(present.map(key));
  const expectedKeys = new Set(expected.map(key));
  return {
    missing: expected.filter((baseline) => !presentKeys.has(key(baseline))),
    orphaned: present.filter((baseline) => !expectedKeys.has(key(baseline))),
    matched: expected.filter((baseline) => presentKeys.has(key(baseline)))
      .length,
  };
}

export function formatReport(report: BaselineReport): string {
  const lines: string[] = [];
  if (report.missing.length > 0) {
    lines.push(
      "Missing baselines — the visual suite will fail on these:\n" +
        report.missing.map((b) => `  ${key(b)}`).join("\n") +
        "\n\n  Record them with the `update-snapshots` workflow rather than\n" +
        "  locally: a baseline is only meaningful against the Chromium build\n" +
        "  and fonts that produced it. See docs/visual-regression.md.",
    );
  }
  if (report.orphaned.length > 0) {
    lines.push(
      "Orphaned baselines — no journey step photographs these:\n" +
        report.orphaned.map((b) => `  ${key(b)}`).join("\n") +
        "\n\n  A renamed or deleted step leaves its image behind, and nothing\n" +
        "  ever compares it again. Delete them, or restore the step.",
    );
  }
  return lines.join("\n\n");
}

export function main(argv: readonly string[]): number {
  const root = argv[0] ?? BASELINE_DIR;
  const report = compareBaselines(expectedBaselines(), presentBaselines(root));

  if (report.missing.length > 0 || report.orphaned.length > 0) {
    console.error(`visual baselines: ${formatReport(report)}\n`);
    return 1;
  }

  // A registry with no steps in it would otherwise be reported as a clean run
  // over nothing, which is the shape of green this repository keeps finding.
  if (report.matched === 0) {
    console.error(
      "visual baselines: the journey registry produced no images at all, so " +
        "this gate checked nothing. `JOURNEY` in e2e/support/journey.ts is " +
        "empty, or no step applies to any surface.\n",
    );
    return 1;
  }

  console.log(
    `visual baselines OK — ${report.matched} image(s) across ` +
      `${SURFACES.length} project(s), none missing and none orphaned.`,
  );
  return 0;
}

/* c8 ignore start -- CLI entry; the logic above is what the tests exercise. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
/* c8 ignore stop */
