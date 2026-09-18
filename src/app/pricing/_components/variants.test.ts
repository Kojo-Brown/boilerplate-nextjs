import { describe, it, expect } from "vitest";
import {
  PRICING_EXPERIMENT_ID,
  PRICING_VARIANT_IDS,
  isPricingVariant,
} from "./variants";
import { findExperiment } from "@/lib/experiments/definitions";

describe("the pricing variants and the registry", () => {
  it("names an experiment that is actually registered", () => {
    expect(findExperiment(PRICING_EXPERIMENT_ID)).toBeDefined();
  });

  it("lists exactly the arms the registry declares", () => {
    // The drift this file exists to catch: an arm added to the registry with
    // no page to render it would be given a share of traffic and answer 404
    // for it. `scripts/assert-experiment-wiring.ts` makes the same assertion
    // in CI, where it can also see the route directory.
    const experiment = findExperiment(PRICING_EXPERIMENT_ID);
    expect(experiment).toBeDefined();
    expect([...PRICING_VARIANT_IDS].sort()).toEqual(
      experiment!.variants.map((variant) => variant.id).sort(),
    );
  });

  it("starts with the arm the canonical page renders", () => {
    const experiment = findExperiment(PRICING_EXPERIMENT_ID);
    expect(experiment?.route?.canonicalVariantId).toBe(PRICING_VARIANT_IDS[0]);
  });
});

describe("isPricingVariant", () => {
  it("accepts every declared arm", () => {
    for (const variant of PRICING_VARIANT_IDS) {
      expect(isPricingVariant(variant)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const value of ["", "Control", "treatment", "../admin", "control "]) {
      expect(isPricingVariant(value)).toBe(false);
    }
  });
});
