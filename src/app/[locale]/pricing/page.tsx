import type { Metadata } from "next";
import { PricingTable } from "./_components/pricing-table";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Plans and pricing for every stage",
};

/**
 * The canonical pricing page, and the control arm of `pricing-cta`.
 *
 * Those are one page on purpose. The obvious alternative — `/pricing` holds no
 * page and the proxy rewrites *every* visitor to `/pricing/v/<arm>` — fails in
 * the one situation that matters most: a request the proxy did not see. A
 * deploy where the matcher has changed, a preview environment, a crawler on a
 * path the proxy skips, a future Next release that renames the file convention
 * again — in each of those `/pricing` answers 404 rather than answering with a
 * pricing page.
 *
 * Here the canonical path is a real, prerendered page carrying the control arm.
 * If bucketing does not run, every visitor sees the control; if it does, half
 * of them are rewritten to the treatment and the other half are served this
 * file with no rewrite at all. Degrading into "everybody sees the layout we
 * already had" is the only acceptable failure mode for an experiment on a
 * page that sells something.
 *
 * `route.canonicalVariantId` in `@/lib/experiments/definitions` is the other
 * end of that arrangement, and `scripts/assert-experiment-wiring.ts` fails if
 * the two stop agreeing.
 */
export default function PricingPage() {
  return <PricingTable variant="control" />;
}
