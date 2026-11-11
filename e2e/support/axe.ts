/**
 * Running axe-core against the application as a browser actually renders it,
 * after hydration and after a click.
 *
 * `scripts/assert-accessibility.ts` audits the documents the build prerenders,
 * which is the right place for that claim and the wrong place for this one. It
 * blocks external scripts on purpose, so nothing hydrates, and it never clicks
 * anything — so the whole interactive surface is outside it by construction. Its
 * own documentation says so, and lists what that leaves uncovered: a dialog's
 * focus trap, a drawer's `Escape` handler, a validation message rendered after a
 * failed submit, content that arrives from behind a Suspense boundary, and
 * `target-size` at a width where a touch target is actually cramped. This module
 * is the other half.
 *
 * The rule sets are imported from that gate rather than restated. Two audits of
 * one application that disagree about what WCAG 2.2 AA means are worse than
 * either alone, and a rule added there should start failing here on the same
 * commit.
 *
 * ## Why axe arrives through `addInitScript`
 *
 * `page.addScriptTag({ content })` appends an inline `<script>` to the document,
 * and this application serves a strict CSP whose `script-src` is `'self'` plus
 * the per-document hashes `scripts/emit-csp-hashes.ts` computes. An injected
 * inline script matches neither, so the browser refuses to run it — and the
 * refusal arrives as a console message, not as a thrown error, so
 * `window.axe` is simply `undefined` at the point of use. `new Function(src)` in
 * `page.evaluate` fails the same way, because `unsafe-eval` is not in the policy
 * either; both of those are page-context script execution and the policy is
 * exactly what stops them.
 *
 * `addInitScript` is delivered over CDP as a script to evaluate on every new
 * document, which is not a document script and is not subject to the policy. It
 * also survives navigation, which matters here: the journey walks several routes
 * in one page and would otherwise need re-injection at every step, and a step
 * that forgot would audit nothing. `bypassCSP: true` on the context would also
 * work and is deliberately not used — it would relax the policy the application
 * ships for the duration of the audit, and this suite should measure the pages
 * as served.
 */
import axe from "axe-core";
import type { Page } from "@playwright/test";
// From `src/lib/a11y/wcag.ts` and not from `scripts/assert-accessibility.ts`,
// which also exports it: Playwright transpiles these specs to CommonJS, and
// that script's CLI entry guard reads `import.meta.url`, which is a syntax
// error outside a module. Importing the gate to borrow one constant would drag
// its whole CLI in with it.
import { WCAG_TAGS } from "../../src/lib/a11y/wcag.js";

export { WCAG_TAGS };

/**
 * Rules whose evaluation needs a layout engine, and therefore the rules whose
 * silence means the audit was not really running.
 *
 * This is the same non-vacuity check the static gate makes, for the same
 * reason: in a DOM without layout, `color-contrast` and `target-size` return
 * `incomplete` for every element on every page, and an `incomplete` result is
 * not a failure. A run that checked neither is indistinguishable from a clean
 * one unless something asks.
 *
 * `target-size` is here and not only in the mobile projects because it is the
 * criterion this suite exists to evaluate at a narrow width — if it stops
 * running at either width, that is worth a red build rather than a quieter
 * report.
 */
export const RULES_THAT_MUST_RUN = ["color-contrast", "target-size"] as const;

/** The parts of an axe node this module reports on. */
export interface AxeNode {
  readonly target: readonly string[];
  readonly html: string;
  readonly failureSummary?: string;
}

/** The parts of an axe result this module reports on. */
export interface AxeResult {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly AxeNode[];
}

export interface AxeRun {
  readonly violations: readonly AxeResult[];
  readonly incomplete: readonly AxeResult[];
  /** Rules that ran and found nothing — the evidence that the run was real. */
  readonly passes: readonly { readonly id: string }[];
}

/** One thing wrong, at one step, in a form that prints usefully. */
export interface Finding {
  /** The journey step the audit ran at. */
  readonly step: string;
  /** `violation` — axe is sure. `incomplete` — axe could not decide. */
  readonly kind: "violation" | "incomplete" | "vacuous" | "stale-allowance";
  readonly rule: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly string[];
}

/**
 * Makes `window.axe` available on every document this page loads, for the
 * lifetime of the page.
 *
 * Call it once, before the first navigation. See the note at the top of this
 * file for why this and not `addScriptTag`.
 */
export async function installAxe(page: Page): Promise<void> {
  await page.addInitScript({ content: axe.source });
}

/**
 * An `incomplete` rule that is accepted at a given step, with the reason it is
 * accepted.
 *
 * An allowance that matches nothing is itself reported, the same way the static
 * gate reports an unused entry: an exemption nobody needs is a hole left open
 * for the next regression, and the only moment anyone will notice it is the
 * moment it stops being needed.
 */
export interface IncompleteAllowance {
  readonly rule: string;
  /** Why this is undecidable rather than wrong. Printed in the report. */
  readonly reason: string;
}

export interface AuditOptions {
  /** The journey step's id, used to label findings. */
  readonly step: string;
  readonly allowIncomplete?: readonly IncompleteAllowance[];
}

/**
 * Runs the WCAG 2.2 AA rule sets over the page as it currently stands and
 * returns everything wrong with it.
 *
 * It returns findings rather than asserting, so one bad step does not hide the
 * rest of the journey: the caller walks every step and reports once. That is
 * the shape the locale move wanted and did not have — 92 findings arriving as
 * "the first one" would have taken 92 CI runs to read.
 *
 * Both `violations` and `incomplete` count. An undecidable result is a rule
 * that did not run, and treating it as a pass is how an audit reports clean on
 * a page it never evaluated.
 */
export async function audit(
  page: Page,
  options: AuditOptions,
): Promise<readonly Finding[]> {
  const run = (await page.evaluate(
    (tags) =>
      (
        window as unknown as {
          axe: {
            run: (context: Document, options: unknown) => Promise<AxeRun>;
          };
        }
      ).axe.run(document, {
        runOnly: { type: "tag", values: tags },
        resultTypes: ["violations", "incomplete"],
      }),
    [...WCAG_TAGS],
  )) as AxeRun;

  const findings: Finding[] = [];
  const allowances = options.allowIncomplete ?? [];
  const used = new Set<string>();

  const describe = (result: AxeResult): readonly string[] =>
    result.nodes.map((node) => {
      const target = node.target.join(" ");
      const summary = node.failureSummary?.replace(/\s+/g, " ").trim();
      return summary === undefined || summary === ""
        ? `${target} — ${node.html}`
        : `${target} — ${summary}`;
    });

  for (const violation of run.violations) {
    findings.push({
      step: options.step,
      kind: "violation",
      rule: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: describe(violation),
    });
  }

  for (const result of run.incomplete) {
    const allowed = allowances.find((entry) => entry.rule === result.id);
    if (allowed !== undefined) {
      used.add(allowed.rule);
      continue;
    }
    findings.push({
      step: options.step,
      kind: "incomplete",
      rule: result.id,
      impact: result.impact,
      help: `${result.help} (axe could not decide; review it and allow it by name if it is genuinely undecidable)`,
      nodes: describe(result),
    });
  }

  for (const allowance of allowances) {
    if (used.has(allowance.rule)) continue;
    findings.push({
      step: options.step,
      kind: "stale-allowance",
      rule: allowance.rule,
      impact: null,
      help:
        `allowed as undecidable (“${allowance.reason}”) but axe decided it — ` +
        `delete the allowance`,
      nodes: [],
    });
  }

  // The non-vacuity check, last so a genuinely broken harness is reported
  // alongside whatever it did manage to find rather than instead of it.
  const ran = new Set(run.passes.map((entry) => entry.id));
  for (const result of [...run.violations, ...run.incomplete]) {
    ran.add(result.id);
  }
  for (const rule of RULES_THAT_MUST_RUN) {
    if (ran.has(rule)) continue;
    findings.push({
      step: options.step,
      kind: "vacuous",
      rule,
      impact: null,
      help:
        `did not run at all, so this audit did not evaluate it — a browser ` +
        `without layout is the usual cause`,
      nodes: [],
    });
  }

  return findings;
}

/** The report the suite prints when anything is wrong. */
export function formatFindings(findings: readonly Finding[]): string {
  const byStep = new Map<string, Finding[]>();
  for (const finding of findings) {
    const bucket = byStep.get(finding.step);
    if (bucket === undefined) byStep.set(finding.step, [finding]);
    else bucket.push(finding);
  }

  const sections: string[] = [];
  for (const [step, bucket] of byStep) {
    const lines = bucket.map((finding) => {
      const impact =
        finding.impact === null
          ? finding.kind
          : `${finding.kind}/${finding.impact}`;
      const nodes =
        finding.nodes.length === 0
          ? ""
          : `\n${finding.nodes.map((node) => `        ${node}`).join("\n")}`;
      return `    [${impact}] ${finding.rule}: ${finding.help}${nodes}`;
    });
    sections.push(`  ${step}\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}
