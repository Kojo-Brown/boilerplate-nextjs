import { describe, it, expect } from "vitest";
import {
  PLANS,
  annualMonthlyEquivalentCents,
  annualSavingPercent,
  formatUsd,
} from "./plans";

describe("PLANS", () => {
  it("has plans", () => {
    expect(PLANS.length).toBeGreaterThan(0);
  });

  it("features exactly one plan", () => {
    // Two featured plans is a layout with two emphasised cards and no
    // recommendation, which is worse than none.
    expect(PLANS.filter((plan) => plan.featured)).toHaveLength(1);
  });

  it("has unique ids", () => {
    expect(new Set(PLANS.map((plan) => plan.id)).size).toBe(PLANS.length);
  });

  it("prices annual below twelve months of monthly", () => {
    // The page claims a saving in both arms. If this stops being true the
    // claim becomes false rather than merely small.
    for (const plan of PLANS) {
      expect(plan.annualCents).toBeLessThan(plan.monthlyCents * 12);
    }
  });

  it("lists plans in ascending price order", () => {
    const prices = PLANS.map((plan) => plan.monthlyCents);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
  });
});

describe("formatUsd", () => {
  it("drops the cents on a whole-dollar price", () => {
    expect(formatUsd(1_200)).toBe("$12");
    expect(formatUsd(126_000)).toBe("$1,260");
  });

  it("keeps the cents when there are any", () => {
    expect(formatUsd(1_250)).toBe("$12.50");
  });

  it("formats zero", () => {
    expect(formatUsd(0)).toBe("$0");
  });
});

describe("annualMonthlyEquivalentCents", () => {
  it("divides the annual price by twelve, rounding down", () => {
    // Down rather than up: rounding up would advertise a monthly equivalent
    // slightly higher than twelve of them actually cost.
    expect(
      annualMonthlyEquivalentCents({
        ...PLANS[0]!,
        annualCents: 11_500,
      }),
    ).toBe(958);
  });

  it("is never more than the monthly price for any live plan", () => {
    for (const plan of PLANS) {
      expect(annualMonthlyEquivalentCents(plan)).toBeLessThan(
        plan.monthlyCents,
      );
    }
  });
});

describe("annualSavingPercent", () => {
  it("computes the discount from the two prices", () => {
    expect(
      annualSavingPercent({
        ...PLANS[0]!,
        monthlyCents: 1_000,
        annualCents: 9_000,
      }),
    ).toBe(25);
  });

  it("rounds to a whole percent", () => {
    expect(
      annualSavingPercent({
        ...PLANS[0]!,
        monthlyCents: 1_000,
        annualCents: 8_990,
      }),
    ).toBe(25);
  });

  it("is a positive whole number for every live plan", () => {
    for (const plan of PLANS) {
      const saving = annualSavingPercent(plan);
      expect(Number.isInteger(saving)).toBe(true);
      expect(saving).toBeGreaterThan(0);
    }
  });

  it("answers zero rather than dividing by zero on a free plan", () => {
    expect(
      annualSavingPercent({ ...PLANS[0]!, monthlyCents: 0, annualCents: 0 }),
    ).toBe(0);
  });
});
