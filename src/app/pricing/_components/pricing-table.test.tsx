// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PLANS, annualMonthlyEquivalentCents, formatUsd } from "./plans";
import { PricingTable } from "./pricing-table";
import { PRICING_VARIANT_IDS } from "./variants";

describe("PricingTable — both arms", () => {
  it.each(PRICING_VARIANT_IDS)("renders every plan in %s", (variant) => {
    render(<PricingTable variant={variant} />);

    for (const plan of PLANS) {
      expect(
        screen.getByRole("heading", { level: 2, name: plan.name }),
      ).toBeInTheDocument();
    }
  });

  it.each(PRICING_VARIANT_IDS)(
    "renders both billing periods in %s",
    (variant) => {
      // The arms differ in which price is the headline and in nothing else. If
      // one of them stopped showing the other period, the experiment would be
      // testing two differences and its result would not be attributable.
      render(<PricingTable variant={variant} />);

      for (const plan of PLANS) {
        expect(
          screen.getByText(new RegExp(escape(formatUsd(plan.annualCents)))),
        ).toBeInTheDocument();
      }
    },
  );

  it.each(PRICING_VARIANT_IDS)("keeps the plan order in %s", (variant) => {
    render(<PricingTable variant={variant} />);

    const names = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(names).toEqual(PLANS.map((plan) => plan.name));
  });

  it.each(PRICING_VARIANT_IDS)("has exactly one h1 in %s", (variant) => {
    render(<PricingTable variant={variant} />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it.each(PRICING_VARIANT_IDS)("says how to force an arm in %s", (variant) => {
    // A page that quietly differs between two visitors should say so.
    render(<PricingTable variant={variant} />);
    expect(screen.getByText(/bkt_pricing-cta=control/)).toBeInTheDocument();
  });
});

describe("PricingTable — control", () => {
  it("leads with the monthly price", () => {
    render(<PricingTable variant="control" />);

    for (const plan of PLANS) {
      expect(
        screen.getByText(formatUsd(plan.monthlyCents), {
          selector: "span",
        }),
      ).toBeInTheDocument();
    }
  });

  it("offers the neutral call to action", () => {
    render(<PricingTable variant="control" />);
    expect(screen.getAllByRole("link", { name: "Get started" }).length).toBe(
      PLANS.length,
    );
  });
});

describe("PricingTable — annual-first", () => {
  it("leads with the annual price expressed per month", () => {
    render(<PricingTable variant="annual-first" />);

    for (const plan of PLANS) {
      expect(
        screen.getByText(formatUsd(annualMonthlyEquivalentCents(plan)), {
          selector: "span",
        }),
      ).toBeInTheDocument();
    }
  });

  it("offers the annual call to action", () => {
    render(<PricingTable variant="annual-first" />);
    expect(
      screen.getAllByRole("link", { name: "Start annual plan" }).length,
    ).toBe(PLANS.length);
  });
});

describe("PricingTable — what the arms share", () => {
  it("links every card to the same destination in both arms", () => {
    // The call to action's wording is part of the treatment. Where it goes is
    // not, and a difference there would be a second variable.
    for (const variant of PRICING_VARIANT_IDS) {
      const { unmount } = render(<PricingTable variant={variant} />);
      for (const link of screen.getAllByRole("link")) {
        if (link.textContent === "docs/experiments.md") continue;
        expect(link).toHaveAttribute("href", "/register");
      }
      unmount();
    }
  });
});

/** Escapes a formatted price for use inside a RegExp. `$12` is not a pattern. */
function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
