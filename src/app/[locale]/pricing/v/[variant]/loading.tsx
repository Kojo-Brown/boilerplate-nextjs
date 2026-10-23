import { PricingSkeleton } from "../../_components/pricing-skeleton";

/**
 * The same frame as `app/pricing/loading.tsx`.
 *
 * Both arms are rewrites of one URL, so a visitor who sees a skeleton here and
 * a visitor who sees one there are on the same navigation as far as the address
 * bar is concerned. Two different skeletons would make the arm visible before
 * the page resolves, which is a difference between the arms that nobody
 * intended to test.
 */
export default function PricingVariantLoading() {
  return <PricingSkeleton />;
}
