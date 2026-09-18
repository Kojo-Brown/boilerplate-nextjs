import Link from "next/link";

/**
 * What an unrecognised arm gets.
 *
 * Reached only by typing a variant path by hand: the proxy never rewrites to an
 * arm the registry does not have, and `generateStaticParams` prerenders exactly
 * the ones it does. It links back to the canonical page rather than to another
 * variant, which is the only link here that is guaranteed to exist for
 * everyone.
 */
export default function PricingVariantNotFound() {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <h2 className="text-xl font-semibold">No such pricing variant</h2>
      <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
        That layout is not one this experiment runs.
      </p>
      <Link
        href="/pricing"
        className="rounded-lg border px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80"
        style={{ borderColor: "var(--border)" }}
      >
        Back to pricing
      </Link>
    </div>
  );
}
