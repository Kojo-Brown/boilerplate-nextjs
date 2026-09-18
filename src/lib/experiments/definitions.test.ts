import { describe, it, expect } from "vitest";
import {
  EXPERIMENTS,
  findExperiment,
  hasVariant,
  validateRegistry,
  type Experiment,
} from "@/lib/experiments/definitions";
import { BUCKET_SPACE } from "@/lib/experiments/hash";

/** A registry entry that passes every rule, for tests to break one field of. */
function validExperiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: "demo",
    salt: "s1",
    variants: [
      { id: "control", weightBasisPoints: 5_000, because: "the old layout" },
      { id: "treatment", weightBasisPoints: 5_000, because: "the new one" },
    ],
    fallbackVariantId: "control",
    because: "a fixture",
    ...overrides,
  };
}

describe("the live registry", () => {
  it("is valid", () => {
    expect(validateRegistry(EXPERIMENTS)).toEqual([]);
  });

  it("is not empty, so the feature is exercised by something real", () => {
    expect(EXPERIMENTS.length).toBeGreaterThan(0);
  });

  it("gives every experiment variants that sum to the bucket space", () => {
    for (const experiment of EXPERIMENTS) {
      const total = experiment.variants.reduce(
        (sum, variant) => sum + variant.weightBasisPoints,
        0,
      );
      expect(total).toBe(BUCKET_SPACE);
    }
  });
});

describe("validateRegistry — weights", () => {
  it("rejects weights that sum short", () => {
    const problems = validateRegistry([
      validExperiment({
        variants: [
          { id: "control", weightBasisPoints: 4_000, because: "a" },
          { id: "treatment", weightBasisPoints: 5_000, because: "b" },
        ],
      }),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("sum to 9000");
  });

  it("rejects weights that sum long", () => {
    const problems = validateRegistry([
      validExperiment({
        variants: [
          { id: "control", weightBasisPoints: 6_000, because: "a" },
          { id: "treatment", weightBasisPoints: 5_000, because: "b" },
        ],
      }),
    ]);
    expect(problems[0]?.message).toContain("sum to 11000");
  });

  it("rejects a negative weight", () => {
    const problems = validateRegistry([
      validExperiment({
        variants: [
          { id: "control", weightBasisPoints: -1, because: "a" },
          { id: "treatment", weightBasisPoints: 10_001, because: "b" },
        ],
      }),
    ]);
    expect(problems.some((p) => p.message.includes("non-negative"))).toBe(true);
  });

  it("accepts a zero-weight arm that is being ramped down", () => {
    expect(
      validateRegistry([
        validExperiment({
          variants: [
            { id: "control", weightBasisPoints: 10_000, because: "a" },
            { id: "treatment", weightBasisPoints: 0, because: "b" },
          ],
        }),
      ]),
    ).toEqual([]);
  });
});

describe("validateRegistry — identity", () => {
  it("rejects a duplicated experiment id", () => {
    const problems = validateRegistry([validExperiment(), validExperiment()]);
    expect(problems[0]?.message).toContain("declared twice");
  });

  it("rejects a duplicated variant id", () => {
    const problems = validateRegistry([
      validExperiment({
        variants: [
          { id: "control", weightBasisPoints: 5_000, because: "a" },
          { id: "control", weightBasisPoints: 5_000, because: "b" },
        ],
      }),
    ]);
    expect(problems.some((p) => p.message.includes("variant control"))).toBe(
      true,
    );
  });

  it("rejects an id outside [a-z0-9-]", () => {
    expect(
      validateRegistry([validExperiment({ id: "Pricing CTA" })])[0]?.message,
    ).toContain("is not [a-z0-9-]");
  });

  it("rejects a salt outside [a-z0-9-]", () => {
    expect(
      validateRegistry([validExperiment({ salt: "autumn 2026" })])[0]?.message,
    ).toContain("is not [a-z0-9-]");
  });

  it("rejects an experiment with one variant", () => {
    const problems = validateRegistry([
      validExperiment({
        variants: [{ id: "control", weightBasisPoints: 10_000, because: "a" }],
      }),
    ]);
    expect(problems.some((p) => p.message.includes("fewer than two"))).toBe(
      true,
    );
  });
});

describe("validateRegistry — fallback and targeting", () => {
  it("rejects a fallback naming a variant that does not exist", () => {
    const problems = validateRegistry([
      validExperiment({ fallbackVariantId: "removed" }),
    ]);
    expect(problems[0]?.message).toContain("is not one of its variants");
  });

  it("rejects a lowercase country code", () => {
    const problems = validateRegistry([validExperiment({ countries: ["us"] })]);
    expect(problems[0]?.message).toContain("ISO 3166-1 alpha-2");
  });

  it("rejects an empty country list", () => {
    const problems = validateRegistry([validExperiment({ countries: [] })]);
    expect(problems[0]?.message).toContain("targets nobody");
  });

  it("accepts an omitted country list as everywhere", () => {
    expect(validateRegistry([validExperiment()])).toEqual([]);
  });
});

describe("validateRegistry — routes", () => {
  const route = {
    path: "/demo",
    canonicalVariantId: "control",
    rewritePrefix: "/demo/v",
  };

  it("accepts a well-formed route", () => {
    expect(validateRegistry([validExperiment({ route })])).toEqual([]);
  });

  it("rejects a relative path", () => {
    const problems = validateRegistry([
      validExperiment({ route: { ...route, path: "demo" } }),
    ]);
    expect(problems.some((p) => p.message.includes("absolute path"))).toBe(
      true,
    );
  });

  it("rejects a trailing slash", () => {
    const problems = validateRegistry([
      validExperiment({
        route: { ...route, path: "/demo/", rewritePrefix: "/demo//v" },
      }),
    ]);
    expect(problems.some((p) => p.message.includes("absolute path"))).toBe(
      true,
    );
  });

  it("rejects two experiments rewriting the same path", () => {
    const problems = validateRegistry([
      validExperiment({ id: "one", route }),
      validExperiment({ id: "two", route }),
    ]);
    expect(problems.some((p) => p.message.includes("both rewrite /demo"))).toBe(
      true,
    );
  });

  it("rejects a canonical variant that is not an arm", () => {
    const problems = validateRegistry([
      validExperiment({
        route: { ...route, canonicalVariantId: "nope" },
      }),
    ]);
    expect(problems.some((p) => p.message.includes("canonicalVariantId"))).toBe(
      true,
    );
  });

  it("rejects a rewrite prefix outside the canonical subtree", () => {
    const problems = validateRegistry([
      validExperiment({
        route: { ...route, rewritePrefix: "/variants" },
      }),
    ]);
    expect(problems[0]?.message).toContain("is not under /demo/");
  });
});

describe("findExperiment / hasVariant", () => {
  it("finds by id", () => {
    expect(findExperiment("demo", [validExperiment()])?.id).toBe("demo");
  });

  it("returns undefined for an unknown id", () => {
    expect(findExperiment("nope", [validExperiment()])).toBeUndefined();
  });

  it("defaults to the live registry", () => {
    const first = EXPERIMENTS[0];
    expect(first).toBeDefined();
    expect(findExperiment(first!.id)).toBe(first);
  });

  it("answers hasVariant", () => {
    const experiment = validExperiment();
    expect(hasVariant(experiment, "control")).toBe(true);
    expect(hasVariant(experiment, "missing")).toBe(false);
  });
});
