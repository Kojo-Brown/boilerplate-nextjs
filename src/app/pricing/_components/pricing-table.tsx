import {
  PLANS,
  annualMonthlyEquivalentCents,
  annualSavingPercent,
  formatUsd,
  type Plan,
} from "./plans";
import type { PricingVariantId } from "./variants";
import { cn } from "@/lib/cn";

/**
 * The page both arms of `pricing-cta` render.
 *
 * One component, parameterised by variant, rather than two pages that drift.
 * The variant changes *which price is the headline* and nothing else — same
 * plans, same features, same order, same copy underneath. That is the whole
 * hypothesis, and keeping it to one component is what stops the experiment
 * from accidentally testing four differences at once, which is the usual way an
 * A/B test produces a number nobody can act on.
 *
 * It is a Server Component with no state, no effects and no event handlers, so
 * both `/pricing` and `/pricing/v/[variant]` prerender as static HTML and the
 * variant costs a visitor no JavaScript at all. `scripts/assert-route-shape.ts`
 * holds that: a `cookies()` or `headers()` read added anywhere above these
 * pages would take them out of the prerender manifest — and reading the
 * assignment header here is exactly the tempting way to do that. The variant
 * arrives as a prop from the path the proxy rewrote to, which is what keeps the
 * page static and the bucketing per-request at the same time.
 */

function PlanCard({
  plan,
  variant,
}: {
  plan: Plan;
  variant: PricingVariantId;
}): React.ReactElement {
  const annualFirst = variant === "annual-first";
  const headlineCents = annualFirst
    ? annualMonthlyEquivalentCents(plan)
    : plan.monthlyCents;

  return (
    <li
      className={cn(
        "flex flex-col gap-4 rounded-xl border p-6",
        plan.featured && "shadow-sm ring-1",
      )}
      style={{
        borderColor: plan.featured ? "var(--primary)" : "var(--border)",
        backgroundColor: "var(--background)",
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">{plan.name}</h2>
        {plan.featured ? (
          <span
            className="rounded-full px-2 py-0.5 text-xs font-medium"
            style={{
              backgroundColor: "var(--muted)",
              color: "var(--muted-foreground)",
            }}
          >
            Most popular
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <p className="flex items-baseline gap-1">
          <span className="text-3xl font-bold tracking-tight">
            {formatUsd(headlineCents)}
          </span>
          <span
            className="text-sm"
            style={{ color: "var(--muted-foreground)" }}
          >
            /month
          </span>
        </p>
        {/*
          The second line is the same two facts in both arms — the other billing
          period and the discount — so the difference between the arms really is
          only which one is set in 30px type.
        */}
        <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
          {annualFirst ? (
            <>
              billed annually at {formatUsd(plan.annualCents)}, or{" "}
              {formatUsd(plan.monthlyCents)}/month month-to-month
            </>
          ) : (
            <>
              billed monthly, or {formatUsd(plan.annualCents)}/year and save{" "}
              {annualSavingPercent(plan)}%
            </>
          )}
        </p>
      </div>

      <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
        {plan.blurb}
      </p>

      <ul className="flex flex-col gap-2 text-sm">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2">
            <span aria-hidden="true">·</span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <a
        href="/register"
        className={cn(
          "mt-auto rounded-lg px-4 py-2.5 text-center text-sm font-medium",
          plan.featured
            ? "bg-primary text-primary-foreground"
            : "border transition-opacity hover:opacity-80",
        )}
        style={plan.featured ? undefined : { borderColor: "var(--border)" }}
      >
        {annualFirst ? "Start annual plan" : "Get started"}
      </a>
    </li>
  );
}

export function PricingTable({
  variant,
}: {
  variant: PricingVariantId;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Pricing</h1>
        <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
          {variant === "annual-first"
            ? "Annual billing, with the month-to-month rate alongside it."
            : "Month-to-month, with annual billing available on every plan."}
        </p>
      </div>

      <ul className="grid gap-6 md:grid-cols-3">
        {PLANS.map((plan) => (
          <PlanCard key={plan.id} plan={plan} variant={variant} />
        ))}
      </ul>

      {/*
        Rendered in both arms and identical in both, so it cannot be what moves
        the number. It is here because a pricing page that quietly differs
        between two visitors is a thing they should be able to find out about.
      */}
      <p
        className="rounded-lg border px-4 py-3 text-sm"
        style={{
          borderColor: "var(--border)",
          backgroundColor: "var(--muted)",
          color: "var(--muted-foreground)",
        }}
      >
        This page is bucketed in the proxy: which of two layouts you see is
        decided once, kept in a cookie, and does not change between visits.
        Append{" "}
        <code className="font-mono text-xs">?bkt_pricing-cta=control</code> or{" "}
        <code className="font-mono text-xs">?bkt_pricing-cta=annual-first</code>{" "}
        to force one. See{" "}
        <a
          href="https://github.com/Kojo-Brown/boilerplate-nextjs/blob/main/docs/experiments.md"
          className="underline underline-offset-4"
        >
          docs/experiments.md
        </a>
        .
      </p>
    </div>
  );
}
