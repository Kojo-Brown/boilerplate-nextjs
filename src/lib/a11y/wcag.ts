/**
 * The axe-core rule sets that define "WCAG 2.2 AA" for this repository.
 *
 * This lives here, rather than in the gate that first needed it, because there
 * are now two audits: `scripts/assert-accessibility.ts` over the documents the
 * build prerenders, and `e2e/a11y-journey.spec.ts` over the same application
 * hydrated and interacted with. Two lists would be two definitions of the
 * target, and the failure mode is quiet — a rule set added to one of them goes
 * on passing in the other, on the same commit, for as long as nobody compares
 * the files.
 *
 * `best-practice` is deliberately absent. A gate that fails on advice nobody
 * agreed to is a gate people stop running.
 */
export const WCAG_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
] as const;
