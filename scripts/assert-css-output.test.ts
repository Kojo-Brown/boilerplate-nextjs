import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_AT_RULES,
  MINIMUM_BUNDLE_BYTES,
  REQUIRED_UTILITIES,
  checkCssOutput,
  formatViolations,
  hasRule,
  type Stylesheet,
} from "./assert-css-output";

/**
 * The bundle the broken build actually produced, verbatim.
 *
 * Kept exact rather than paraphrased: this is the artefact the gate exists to
 * reject, and a hand-written approximation of it would drift into something
 * easier to catch than the real thing. Note the trailing `@utility` rules —
 * Tailwind's own syntax, copied through untouched into a file browsers were
 * expected to parse.
 */
const BROKEN_BUNDLE =
  "@layer base{:root{--primary:#0073d2;--primary-foreground:#fff;--background:#fff;" +
  "--foreground:#020202;--muted:#f2f2f2;--muted-foreground:#555;--border:#dedede;--radius:.5rem}" +
  ".dark{--background:#020202;--foreground:#f8f8f8;--muted:#0b0b0b;--muted-foreground:#8f8f8f;" +
  "--border:#1b1b1b}*{border-color:var(--border)}body{background-color:var(--background);" +
  "color:var(--foreground);-webkit-font-smoothing:antialiased;font-family:system-ui,sans-serif}}" +
  "@utility primary{background-color: var(--primary);}" +
  "@utility primary-foreground{color: var(--primary-foreground);}" +
  "@utility muted-foreground{color: var(--muted-foreground);}";

/**
 * A stylesheet with the shape of a healthy build: every required utility
 * present, escaped the way Tailwind escapes them, plus enough filler to clear
 * the size floor. The filler is real-looking rules rather than a comment so
 * that nothing in the gate can be satisfied by padding alone.
 */
function healthyStylesheet(): Stylesheet {
  return {
    file: "static/chunks/app.css",
    css: rulesFor(REQUIRED_UTILITIES) + FILLER,
  };
}

/** Renders a rule per utility, escaped the way Tailwind would write it. */
function rulesFor(utilities: readonly { utility: string }[]): string {
  return utilities
    .map(({ utility }) => `.${escapeSelector(utility)}{color:red}`)
    .join("");
}

/**
 * Enough plausible CSS to clear the size floor with room to spare.
 *
 * Sized generously on purpose: an earlier version landed 39 bytes under
 * `MINIMUM_BUNDLE_BYTES`, so dropping three utilities from a fixture tripped
 * the size check as well and the test was really asserting two things at once.
 * The floor is not what these cases are about.
 */
const FILLER = Array.from(
  { length: 1500 },
  (_, i) => `.filler-${i}{margin:${i}px}`,
).join("");

/** Escapes a class name the way Tailwind writes it into a selector. */
function escapeSelector(utility: string): string {
  return utility.replace(/[:/[\].]/g, (char) => `\\${char}`);
}

describe("hasRule", () => {
  it("finds a plain utility", () => {
    expect(hasRule(".flex{display:flex}", "flex")).toBe(true);
  });

  it("finds a utility Tailwind escaped for a variant", () => {
    expect(
      hasRule(".hover\\:bg-muted:hover{background:#eee}", "hover:bg-muted"),
    ).toBe(true);
  });

  it("finds a utility with an escaped arbitrary value", () => {
    expect(
      hasRule(".aspect-\\[3\\/2\\]{aspect-ratio:3/2}", "aspect-[3/2]"),
    ).toBe(true);
  });

  it("does not accept a longer utility that merely starts the same", () => {
    // The bug this guards: `.flex-col` must not satisfy a requirement for
    // `.flex`, or the gate passes on a build missing the utility it names.
    expect(hasRule(".flex-col{flex-direction:column}", "flex")).toBe(false);
    expect(hasRule(".grid-cols-3{}", "grid")).toBe(false);
  });

  it("accepts a utility used in a compound or descendant selector", () => {
    expect(hasRule(".dark .bg-muted{background:#111}", "bg-muted")).toBe(true);
    expect(hasRule(".flex.absolute{}", "absolute")).toBe(true);
    expect(
      hasRule(".group:hover .group-hover\\:underline{}", "group:hover"),
    ).toBe(true);
  });

  it("does not mistake a custom property or declaration for a rule", () => {
    expect(hasRule(":root{--flex:1}", "flex")).toBe(false);
  });
});

describe("checkCssOutput", () => {
  it("passes a healthy bundle", () => {
    expect(checkCssOutput([healthyStylesheet()])).toEqual([]);
  });

  it("rejects the exact bundle the broken build shipped", () => {
    const violations = checkCssOutput([
      { file: "static/chunks/0.css", css: BROKEN_BUNDLE },
    ]);

    // Three independent signals should fire on it, not just one: it is far
    // under the size floor, it carries `@utility` through, and it has none of
    // the utilities. Any one of them alone would have caught this regression;
    // relying on exactly one would make the gate brittle.
    expect(violations.length).toBeGreaterThan(3);
    expect(violations.some((v) => v.problem.includes("below the"))).toBe(true);
    expect(violations.some((v) => v.problem.includes("`@utility`"))).toBe(true);
    expect(violations.some((v) => v.problem.includes("`.flex`"))).toBe(true);
  });

  it("reports a build that wrote no stylesheet at all", () => {
    const violations = checkCssOutput([]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("no stylesheet at all");
  });

  it("fails when the `@theme inline` colours are gone but layout still compiles", () => {
    // The partial regression a size floor cannot see: deleting the `@theme`
    // block from globals.css leaves `flex` and `grid-cols-3` intact and only
    // breaks the semantic colours, costing perhaps 200 bytes.
    const themeless = rulesFor(
      REQUIRED_UTILITIES.filter(
        ({ utility }) =>
          !["bg-primary", "text-muted-foreground", "ring-border"].includes(
            utility,
          ),
      ),
    );

    const violations = checkCssOutput([
      { file: "static/chunks/app.css", css: themeless + FILLER },
    ]);

    // Exactly the three colour utilities, and nothing about the bundle size —
    // the whole point is that this regression is invisible to a size check.
    expect(violations.map((v) => v.problem)).toEqual([
      "no rule for `.bg-primary` in any emitted stylesheet.",
      "no rule for `.text-muted-foreground` in any emitted stylesheet.",
      "no rule for `.ring-border` in any emitted stylesheet.",
    ]);
  });

  it("flags every forbidden at-rule that survives into the output", () => {
    for (const atRule of FORBIDDEN_AT_RULES) {
      const sheet = healthyStylesheet();
      const violations = checkCssOutput([
        { ...sheet, css: `${sheet.css}${atRule} foo{color:red}` },
      ]);
      expect(
        violations.some((v) => v.problem.includes(`\`${atRule}\``)),
        `${atRule} should be rejected`,
      ).toBe(true);
    }
  });

  it("names the offending file when several stylesheets are emitted", () => {
    const healthy = healthyStylesheet();
    const violations = checkCssOutput([
      healthy,
      { file: "static/chunks/late.css", css: "@utility thing{color:red}" },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("static/chunks/late.css");
  });

  it("sums bytes across stylesheets rather than requiring one large file", () => {
    // Next splits CSS per entry point, so a healthy build can emit several
    // small files. Applying the floor per file would fail all of them.
    const { css } = healthyStylesheet();
    const half = Math.ceil(css.length / 2);
    const violations = checkCssOutput([
      { file: "static/chunks/a.css", css: css.slice(0, half) },
      { file: "static/chunks/b.css", css: css.slice(half) },
    ]);

    expect(violations.filter((v) => v.problem.includes("below the"))).toEqual(
      [],
    );
  });

  it("only requires utilities the caller asks for", () => {
    expect(
      checkCssOutput(
        [{ file: "a.css", css: ".flex{display:flex}".padEnd(20_000, " ") }],
        [{ utility: "flex", because: "the only one under test" }],
      ),
    ).toEqual([]);
  });
});

describe("REQUIRED_UTILITIES", () => {
  it("gives every entry a reason, since that reason is the failure message", () => {
    for (const { utility, because } of REQUIRED_UTILITIES) {
      expect(utility, "utility must be non-empty").not.toBe("");
      expect(because.length, `${utility} needs a reason`).toBeGreaterThan(10);
    }
  });

  it("names no utility twice", () => {
    const names = REQUIRED_UTILITIES.map((r) => r.utility);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("formatViolations", () => {
  it("prints the problem and its reason", () => {
    const output = formatViolations([
      { problem: "no rule for `.flex`.", because: "layout would collapse" },
    ]);
    expect(output).toContain("no rule for `.flex`.");
    expect(output).toContain("expected because: layout would collapse");
  });
});

describe("MINIMUM_BUNDLE_BYTES", () => {
  it("sits between the broken bundle and the real one", () => {
    // The floor is only meaningful if it separates the two bundles that
    // actually occurred: 1,103 bytes broken, ~34 KB compiled.
    expect(MINIMUM_BUNDLE_BYTES).toBeGreaterThan(BROKEN_BUNDLE.length);
    expect(MINIMUM_BUNDLE_BYTES).toBeLessThan(34_000);
  });
});
