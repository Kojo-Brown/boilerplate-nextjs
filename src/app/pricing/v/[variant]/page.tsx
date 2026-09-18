import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PricingTable } from "../../_components/pricing-table";
import {
  PRICING_VARIANT_IDS,
  isPricingVariant,
} from "../../_components/variants";

/**
 * The non-canonical arms, served by a proxy rewrite.
 *
 * A visitor never sees this path in their address bar: `@/lib/experiments/edge`
 * rewrites `/pricing` here, which changes what renders and not what the URL
 * says. A redirect would do the opposite, and the difference is not cosmetic —
 * it would put the arm in the visitor's history and in every link they share,
 * and it would give a search engine two URLs with near-identical content to
 * decide between.
 *
 * The path is nonetheless reachable directly, and that is deliberate: it is how
 * a reviewer opens both arms side by side, and how a bug report can name the one
 * it was seen in. What it is *not* is where traffic is sent, so it carries
 * `robots: { index: false }` — an indexed `/pricing/v/annual-first` would be
 * exactly the duplicate-content problem the rewrite exists to avoid, arrived at
 * the long way round.
 */

/**
 * The complete set of arms, prerendered at build time.
 *
 * `export const dynamicParams = false` is the usual way to say "and nothing
 * else", and it is not available here: `cacheComponents` is on repo-wide and
 * the build rejects the export outright — *"Route segment config
 * `dynamicParams` is not compatible with `nextConfig.cacheComponents`"*. That
 * is the same family of restriction `@/lib/api/runtimes` documents for the
 * `runtime` export, and it was found the same way, by the build failing on it
 * rather than by reading the release notes.
 *
 * So the closed set is enforced in the body instead. `notFound()` on an
 * unrecognised arm is what stands between `/pricing/v/anything` and a page
 * rendered with an arm nothing assigns, and the narrowing it performs is also
 * what tells TypeScript the string is one of the arms `PricingTable` accepts.
 * `scripts/assert-experiment-wiring.ts` asserts the call is there.
 *
 * What it does *not* buy is the status code, and that is worth being exact
 * about: the shell is prerendered and sent before this body runs, so the
 * response is already 200 by the time `notFound()` is reached. The visitor gets
 * `not-found.tsx` rendered inside a 200. `/photos/[id]` answers unknown ids the
 * same way and has since it landed; it is a property of Cache Components, not
 * of this route. `e2e/experiments.spec.ts` asserts the boundary rather than the
 * status, because the boundary is what is true.
 */
export function generateStaticParams(): { variant: string }[] {
  return PRICING_VARIANT_IDS.map((variant) => ({ variant }));
}

export const metadata: Metadata = {
  title: "Pricing",
  description: "Plans and pricing for every stage",
  robots: { index: false, follow: true },
};

export default async function PricingVariantPage({
  params,
}: {
  params: Promise<{ variant: string }>;
}) {
  const { variant } = await params;
  if (!isPricingVariant(variant)) notFound();

  return <PricingTable variant={variant} />;
}
