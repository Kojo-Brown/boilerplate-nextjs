/**
 * The plans `/pricing` renders, and the arithmetic that must not drift.
 *
 * Prices are integer cents. Not a decimal, and not a formatted string: a plan
 * whose annual price is stored as `"$180"` cannot be compared with its monthly
 * one, so the "save 25%" claim next to it becomes a number someone typed once
 * and nobody re-derives. Both arms of the pricing experiment show a discount
 * figure, and they have to agree — `annualSavingPercent` below computes it from
 * the two prices, so a price change moves the claim with it.
 */

export interface Plan {
  readonly id: string;
  readonly name: string;
  /** Per month, billed monthly, in cents. */
  readonly monthlyCents: number;
  /** Per year, billed annually, in cents. */
  readonly annualCents: number;
  readonly blurb: string;
  readonly features: readonly string[];
  /** The one plan drawn with emphasis. Exactly one, asserted in the tests. */
  readonly featured?: true;
}

export const PLANS: readonly Plan[] = [
  {
    id: "starter",
    name: "Starter",
    monthlyCents: 1_200,
    annualCents: 11_500,
    blurb: "One project, and the parts of the stack you need to ship it.",
    features: ["1 project", "10k requests / month", "Community support"],
  },
  {
    id: "team",
    name: "Team",
    monthlyCents: 4_800,
    annualCents: 43_200,
    blurb: "Shared projects, roles, and an audit trail over both.",
    features: [
      "Unlimited projects",
      "1M requests / month",
      "Role-based access",
      "Email support",
    ],
    featured: true,
  },
  {
    id: "scale",
    name: "Scale",
    monthlyCents: 14_000,
    annualCents: 126_000,
    blurb: "Volume pricing, a support commitment, and single sign-on.",
    features: [
      "Everything in Team",
      "10M requests / month",
      "SAML SSO",
      "99.9% uptime SLA",
    ],
  },
];

/**
 * `1_200` → `$12`, `11_500` → `$115`, `1_250` → `$12.50`.
 *
 * `Intl.NumberFormat` rather than a template string, and constructed per call
 * rather than hoisted to module scope: hoisting it would bake the currency into
 * a module the proxy's geo targeting exists to be careful about, and the cost
 * of constructing one is nothing next to rendering a page. The trailing `.00`
 * is dropped because whole-dollar prices read as prices and `$12.00` reads as a
 * receipt.
 */
export function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** The annual price expressed as a per-month figure, in cents, rounded down. */
export function annualMonthlyEquivalentCents(plan: Plan): number {
  return Math.floor(plan.annualCents / 12);
}

/**
 * How much the annual plan saves, as a whole percent.
 *
 * Rounded rather than floored: the claim is marketing copy, not a contract, and
 * flooring 24.9% to 24 understates a real discount. The numbers in `PLANS` are
 * chosen so this lands on a whole number anyway; the rounding is here so that
 * changing one of them cannot produce `20.166666666666668%` on the page.
 */
export function annualSavingPercent(plan: Plan): number {
  const yearAtMonthlyRate = plan.monthlyCents * 12;
  if (yearAtMonthlyRate === 0) return 0;
  return Math.round(
    ((yearAtMonthlyRate - plan.annualCents) / yearAtMonthlyRate) * 100,
  );
}
