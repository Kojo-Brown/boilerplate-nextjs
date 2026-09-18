import { describe, it, expect } from "vitest";
import {
  assignmentsChanged,
  persistableAssignments,
  resolveAssignments,
  selectVariant,
} from "@/lib/experiments/assignment";
import { UNKNOWN_COUNTRY } from "@/lib/experiments/geo";
import type { Experiment } from "@/lib/experiments/definitions";

const EVEN_SPLIT: Experiment = {
  id: "demo",
  salt: "s1",
  variants: [
    { id: "control", weightBasisPoints: 5_000, because: "a" },
    { id: "treatment", weightBasisPoints: 5_000, because: "b" },
  ],
  fallbackVariantId: "control",
  because: "a fixture",
};

const TARGETED: Experiment = {
  ...EVEN_SPLIT,
  id: "targeted",
  countries: ["US", "CA"],
};

function resolve(
  experiments: readonly Experiment[],
  options: {
    visitorId?: string;
    country?: string;
    existing?: [string, string][];
    overrides?: [string, string][];
  } = {},
) {
  return resolveAssignments({
    experiments,
    visitorId: options.visitorId ?? "visitor-1",
    country: options.country ?? "US",
    existing: new Map(options.existing ?? []),
    overrides: new Map(options.overrides ?? []),
  });
}

describe("selectVariant", () => {
  const variants = [
    { id: "a", weightBasisPoints: 3_000, because: "" },
    { id: "b", weightBasisPoints: 7_000, because: "" },
  ];

  it("uses half-open intervals in declaration order", () => {
    expect(selectVariant(variants, 0)?.id).toBe("a");
    expect(selectVariant(variants, 2_999)?.id).toBe("a");
    expect(selectVariant(variants, 3_000)?.id).toBe("b");
    expect(selectVariant(variants, 9_999)?.id).toBe("b");
  });

  it("gives a zero-weight arm no buckets at all", () => {
    // "Ramp this arm down to zero" has to mean zero, not one bucket in ten
    // thousand — which is what a `<=` comparison would leave it with.
    const ramped = [
      { id: "off", weightBasisPoints: 0, because: "" },
      { id: "on", weightBasisPoints: 10_000, because: "" },
    ];
    for (const bucket of [0, 1, 5_000, 9_999]) {
      expect(selectVariant(ramped, bucket)?.id).toBe("on");
    }
  });

  it("answers with the last arm if the weights leave a gap", () => {
    const short = [{ id: "only", weightBasisPoints: 1, because: "" }];
    expect(selectVariant(short, 9_999)?.id).toBe("only");
  });

  it("returns undefined for no variants at all", () => {
    expect(selectVariant([], 0)).toBeUndefined();
  });
});

describe("resolveAssignments — hashing", () => {
  it("assigns an arm of the experiment", () => {
    const [assignment] = resolve([EVEN_SPLIT]);
    expect(["control", "treatment"]).toContain(assignment?.variantId);
    expect(assignment?.source).toBe("hash");
    expect(assignment?.exposed).toBe(true);
  });

  it("is stable for one visitor across calls", () => {
    const first = resolve([EVEN_SPLIT])[0]?.variantId;
    const second = resolve([EVEN_SPLIT])[0]?.variantId;
    expect(first).toBe(second);
  });

  it("returns one assignment per experiment, in registry order", () => {
    const assignments = resolve([EVEN_SPLIT, { ...EVEN_SPLIT, id: "other" }]);
    expect(assignments.map((a) => a.experimentId)).toEqual(["demo", "other"]);
  });

  it("splits a population roughly evenly", () => {
    let treatment = 0;
    const total = 4_000;
    for (let index = 0; index < total; index += 1) {
      const [assignment] = resolve([EVEN_SPLIT], {
        visitorId: `visitor-${index}`,
      });
      if (assignment?.variantId === "treatment") treatment += 1;
    }
    expect(Math.abs(treatment / total - 0.5)).toBeLessThan(0.03);
  });
});

describe("resolveAssignments — the cookie wins", () => {
  it("keeps a remembered arm rather than re-hashing", () => {
    // The point of persisting at all: a weight change must not move anyone who
    // is already in the experiment.
    const skewed: Experiment = {
      ...EVEN_SPLIT,
      variants: [
        { id: "control", weightBasisPoints: 10_000, because: "a" },
        { id: "treatment", weightBasisPoints: 0, because: "b" },
      ],
    };
    const [assignment] = resolve([skewed], {
      existing: [["demo", "treatment"]],
    });
    expect(assignment?.variantId).toBe("treatment");
    expect(assignment?.source).toBe("cookie");
    expect(assignment?.exposed).toBe(true);
  });

  it("keeps a remembered arm even outside the targeted countries", () => {
    // A visitor who travels has already seen their arm; moving them would put
    // one person's sessions in both arms.
    const [assignment] = resolve([TARGETED], {
      country: "DE",
      existing: [["targeted", "treatment"]],
    });
    expect(assignment?.variantId).toBe("treatment");
    expect(assignment?.source).toBe("cookie");
  });

  it("discards a remembered arm the experiment no longer has", () => {
    const [assignment] = resolve([EVEN_SPLIT], {
      existing: [["demo", "retired-arm"]],
    });
    expect(assignment?.source).toBe("hash");
    expect(["control", "treatment"]).toContain(assignment?.variantId);
  });

  it("ignores a cookie entry for an experiment that is not running", () => {
    const assignments = resolve([EVEN_SPLIT], {
      existing: [["long-gone", "whatever"]],
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.experimentId).toBe("demo");
  });
});

describe("resolveAssignments — targeting", () => {
  it("serves the fallback outside the targeted countries", () => {
    const [assignment] = resolve([TARGETED], { country: "DE" });
    expect(assignment?.variantId).toBe("control");
    expect(assignment?.source).toBe("targeting");
  });

  it("does not count untargeted traffic as a measurement", () => {
    expect(resolve([TARGETED], { country: "DE" })[0]?.exposed).toBe(false);
  });

  it("excludes traffic whose country could not be established", () => {
    expect(resolve([TARGETED], { country: UNKNOWN_COUNTRY })[0]?.source).toBe(
      "targeting",
    );
  });

  it("includes unknown traffic in an untargeted experiment", () => {
    expect(resolve([EVEN_SPLIT], { country: UNKNOWN_COUNTRY })[0]?.source).toBe(
      "hash",
    );
  });
});

describe("resolveAssignments — overrides", () => {
  it("forces the named arm", () => {
    const [assignment] = resolve([EVEN_SPLIT], {
      overrides: [["demo", "treatment"]],
    });
    expect(assignment?.variantId).toBe("treatment");
    expect(assignment?.source).toBe("override");
  });

  it("does not count a forced arm as a measurement", () => {
    // Anyone can send the query parameter, so a link that forces an arm may
    // change what one person sees and must not change the numbers.
    expect(
      resolve([EVEN_SPLIT], { overrides: [["demo", "treatment"]] })[0]?.exposed,
    ).toBe(false);
  });

  it("outranks the cookie", () => {
    expect(
      resolve([EVEN_SPLIT], {
        existing: [["demo", "control"]],
        overrides: [["demo", "treatment"]],
      })[0]?.variantId,
    ).toBe("treatment");
  });

  it("outranks targeting", () => {
    expect(
      resolve([TARGETED], {
        country: "DE",
        overrides: [["targeted", "treatment"]],
      })[0]?.variantId,
    ).toBe("treatment");
  });

  it("ignores an override naming an arm that does not exist", () => {
    const [assignment] = resolve([EVEN_SPLIT], {
      overrides: [["demo", "nonsense"]],
    });
    expect(assignment?.source).toBe("hash");
  });
});

describe("persistableAssignments", () => {
  it("persists hashed and remembered arms", () => {
    expect(
      persistableAssignments([
        {
          experimentId: "a",
          variantId: "one",
          source: "hash",
          exposed: true,
        },
        {
          experimentId: "b",
          variantId: "two",
          source: "cookie",
          exposed: true,
        },
      ]),
    ).toEqual([
      ["a", "one"],
      ["b", "two"],
    ]);
  });

  it("persists neither an override nor a targeting fallback", () => {
    // An override is self-selected and a fallback means "not in the
    // experiment" — writing either would pin the visitor for a year.
    expect(
      persistableAssignments([
        {
          experimentId: "a",
          variantId: "one",
          source: "override",
          exposed: false,
        },
        {
          experimentId: "b",
          variantId: "two",
          source: "targeting",
          exposed: false,
        },
      ]),
    ).toEqual([]);
  });
});

describe("assignmentsChanged", () => {
  it("is false when nothing moved", () => {
    expect(assignmentsChanged([["a", "one"]], new Map([["a", "one"]]))).toBe(
      false,
    );
  });

  it("is true when an experiment was added", () => {
    expect(
      assignmentsChanged(
        [
          ["a", "one"],
          ["b", "two"],
        ],
        new Map([["a", "one"]]),
      ),
    ).toBe(true);
  });

  it("is true when an experiment was retired", () => {
    expect(
      assignmentsChanged(
        [["a", "one"]],
        new Map([
          ["a", "one"],
          ["b", "two"],
        ]),
      ),
    ).toBe(true);
  });

  it("is true when a variant changed", () => {
    expect(assignmentsChanged([["a", "two"]], new Map([["a", "one"]]))).toBe(
      true,
    );
  });

  it("is true when the order changed", () => {
    expect(
      assignmentsChanged(
        [
          ["b", "two"],
          ["a", "one"],
        ],
        new Map([
          ["a", "one"],
          ["b", "two"],
        ]),
      ),
    ).toBe(true);
  });

  it("is false for two empty sets", () => {
    expect(assignmentsChanged([], new Map())).toBe(false);
  });
});
