/**
 * The arms of `pricing-cta`, as the pages need them.
 *
 * This list exists a second time — `@/lib/experiments/definitions` is the first
 * — and that duplication is deliberate, because the two are different kinds of
 * fact. The registry is configuration: weights and targeting change while the
 * application is running, and changing them must not require a deploy of the
 * pages. This is a *type*: `PricingTable` renders one layout per arm, and an
 * arm with no layout is a page that cannot be written.
 *
 * Deriving the type from the registry would collapse the two and lose the check
 * that matters — adding a variant to the registry would then compile, ship, and
 * 404 for the share of traffic it was given, because no page renders it. Keeping
 * them separate turns that into a type error in `PricingTable` and, for anyone
 * who reaches for a cast, a failure in
 * `scripts/assert-experiment-wiring.ts`, which asserts these two lists are
 * exactly equal.
 */

export const PRICING_EXPERIMENT_ID = "pricing-cta";

export const PRICING_VARIANT_IDS = ["control", "annual-first"] as const;

export type PricingVariantId = (typeof PRICING_VARIANT_IDS)[number];

export function isPricingVariant(value: string): value is PricingVariantId {
  return (PRICING_VARIANT_IDS as readonly string[]).includes(value);
}
