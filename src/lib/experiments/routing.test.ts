import { describe, it, expect } from "vitest";
import {
  OVERRIDE_PREFIX,
  parseOverrides,
  participates,
  resolveRewrite,
  variantPath,
} from "@/lib/experiments/routing";
import type { Assignment } from "@/lib/experiments/assignment";
import type { Experiment } from "@/lib/experiments/definitions";

const ROUTED: Experiment = {
  id: "demo",
  salt: "s1",
  variants: [
    { id: "control", weightBasisPoints: 5_000, because: "a" },
    { id: "treatment", weightBasisPoints: 5_000, because: "b" },
  ],
  fallbackVariantId: "control",
  route: {
    path: "/demo",
    canonicalVariantId: "control",
    rewritePrefix: "/demo/v",
  },
  because: "a fixture",
};

// Built by omitting `route` rather than setting it to `undefined`:
// `exactOptionalPropertyTypes` is on, and an optional property that is present
// and undefined is not the same thing as an absent one.
const { route: _route, ...UNROUTED_BASE } = ROUTED;
const UNROUTED: Experiment = { ...UNROUTED_BASE, id: "headless" };

function assignment(variantId: string, experimentId = "demo"): Assignment {
  return { experimentId, variantId, source: "hash", exposed: true };
}

describe("parseOverrides", () => {
  it("reads a prefixed parameter", () => {
    expect([
      ...parseOverrides(
        new URLSearchParams(`${OVERRIDE_PREFIX}demo=treatment`),
      ),
    ]).toEqual([["demo", "treatment"]]);
  });

  it("ignores parameters without the prefix", () => {
    expect(parseOverrides(new URLSearchParams("demo=treatment")).size).toBe(0);
  });

  it("ignores ids and values outside [a-z0-9-]", () => {
    expect(parseOverrides(new URLSearchParams("bkt_Demo=x")).size).toBe(0);
    expect(parseOverrides(new URLSearchParams("bkt_demo=Treatment")).size).toBe(
      0,
    );
    expect(parseOverrides(new URLSearchParams("bkt_demo=<script>")).size).toBe(
      0,
    );
  });

  it("ignores an empty id or value", () => {
    expect(parseOverrides(new URLSearchParams("bkt_=x")).size).toBe(0);
    expect(parseOverrides(new URLSearchParams("bkt_demo=")).size).toBe(0);
  });

  it("keeps the first of a repeated parameter", () => {
    expect(
      parseOverrides(
        new URLSearchParams("bkt_demo=control&bkt_demo=treatment"),
      ).get("demo"),
    ).toBe("control");
  });

  it("reads several experiments at once", () => {
    expect(
      parseOverrides(new URLSearchParams("bkt_a=one&bkt_b=two")).size,
    ).toBe(2);
  });
});

describe("participates", () => {
  it("includes pages", () => {
    expect(participates("/")).toBe(true);
    expect(participates("/pricing")).toBe(true);
    expect(participates("/apifoo")).toBe(true);
  });

  it("excludes route handlers", () => {
    // A `fetch` has no browser to keep a cookie in, so minting a visitor id for
    // one would re-mint on every poll and put Set-Cookie on cacheable JSON.
    expect(participates("/api")).toBe(false);
    expect(participates("/api/health")).toBe(false);
  });

  it("excludes Next internals", () => {
    expect(participates("/_next/static/chunk.js")).toBe(false);
  });
});

describe("variantPath", () => {
  it("appends the variant to the rewrite prefix", () => {
    expect(variantPath(ROUTED, "treatment")).toBe("/demo/v/treatment");
  });
});

describe("resolveRewrite", () => {
  it("rewrites a non-canonical arm on the canonical path", () => {
    expect(
      resolveRewrite("/demo", [assignment("treatment")], [ROUTED]),
    ).toEqual({
      experimentId: "demo",
      variantId: "treatment",
      from: "/demo",
      to: "/demo/v/treatment",
    });
  });

  it("does not rewrite the canonical arm", () => {
    // The canonical page renders it already — and this is what makes /demo
    // answer correctly when the proxy never runs.
    expect(
      resolveRewrite("/demo", [assignment("control")], [ROUTED]),
    ).toBeUndefined();
  });

  it("does not rewrite any other path", () => {
    expect(
      resolveRewrite("/demo/v/treatment", [assignment("treatment")], [ROUTED]),
    ).toBeUndefined();
    expect(
      resolveRewrite("/demo/extra", [assignment("treatment")], [ROUTED]),
    ).toBeUndefined();
    expect(
      resolveRewrite("/", [assignment("treatment")], [ROUTED]),
    ).toBeUndefined();
  });

  it("does not rewrite for an experiment with no route", () => {
    expect(
      resolveRewrite(
        "/demo",
        [assignment("treatment", "headless")],
        [UNROUTED],
      ),
    ).toBeUndefined();
  });

  it("does not rewrite when the request has no assignment", () => {
    expect(resolveRewrite("/demo", [], [ROUTED])).toBeUndefined();
  });

  it("does not rewrite to an arm the experiment does not have", () => {
    // resolveAssignments cannot produce this; it is checked anyway because the
    // cost of being wrong is a rewrite to a path that does not exist.
    expect(
      resolveRewrite("/demo", [assignment("ghost")], [ROUTED]),
    ).toBeUndefined();
  });

  it("matches the right experiment out of several", () => {
    const other: Experiment = {
      ...ROUTED,
      id: "other",
      route: {
        path: "/other",
        canonicalVariantId: "control",
        rewritePrefix: "/other/v",
      },
    };
    expect(
      resolveRewrite(
        "/other",
        [assignment("control"), assignment("treatment", "other")],
        [ROUTED, other],
      )?.to,
    ).toBe("/other/v/treatment");
  });
});
