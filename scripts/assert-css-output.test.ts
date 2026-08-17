import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_AT_RULES,
  MINIMUM_BUNDLE_BYTES,
  REQUIRED_CLASS_KEYED_DARK,
  REQUIRED_OVERRIDES,
  REQUIRED_UTILITIES,
  checkCssOutput,
  checkDarkVariant,
  checkOverrideOrder,
  formatViolations,
  hasRule,
  headsSelector,
  ruleIndices,
  scanRules,
  splitSelectorList,
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
    css: rulesFor(REQUIRED_UTILITIES) + classKeyedDarkRules() + FILLER,
  };
}

/** Renders a rule per utility, escaped the way Tailwind would write it. */
function rulesFor(utilities: readonly { utility: string }[]): string {
  return utilities
    .map(({ utility }) => `.${escapeSelector(utility)}{color:red}`)
    .join("");
}

/**
 * The `dark:` utilities as a healthy build writes them: keyed on the class,
 * with the `:where()` condition Tailwind appends before the rest of the
 * variant chain.
 *
 * Written with the compiler's minified spacing (`.dark,.dark *`) rather than
 * the spacing of the `@custom-variant` declaration in `globals.css`
 * (`.dark, .dark *`), because that is the form the gate actually reads — and
 * a fixture that used the source spelling would not prove the gate tolerates
 * the emitted one.
 */
function classKeyedDarkRules(
  utilities: readonly { utility: string }[] = REQUIRED_CLASS_KEYED_DARK,
): string {
  return utilities
    .map(({ utility }) => {
      // `dark:hover:bg-*` compiles with the `:hover` after the condition, so
      // the fixture puts it there too.
      const trailing = utility.includes("hover:") ? ":hover" : "";
      return `.${escapeSelector(utility)}:where(.dark,.dark *)${trailing}{color:red}`;
    })
    .join("");
}

/** The same utilities as Tailwind's built-in variant writes them: media-guarded. */
function mediaGuardedDarkRules(
  utilities: readonly { utility: string }[] = REQUIRED_CLASS_KEYED_DARK,
): string {
  const rules = utilities
    .map(({ utility }) => {
      const trailing = utility.includes("hover:") ? ":hover" : "";
      return `.${escapeSelector(utility)}${trailing}{color:red}`;
    })
    .join("");
  return `@media (prefers-color-scheme:dark){${rules}}`;
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
      {
        file: "static/chunks/app.css",
        css: themeless + classKeyedDarkRules() + FILLER,
      },
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
        [],
        [],
      ),
    ).toEqual([]);
  });

  it("checks override order as part of the whole-bundle pass", () => {
    // The override list is reached through `checkCssOutput`, not only through
    // `checkOverrideOrder` directly — otherwise CI would never run it.
    const inverted = ".prose-app{--tw-prose-body:red}.prose{color:blue}";
    const violations = checkCssOutput(
      [{ file: "a.css", css: inverted.padEnd(20_000, " ") }],
      [],
      REQUIRED_OVERRIDES,
      [],
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain(
      "emits `.prose-app` before `.prose`",
    );
  });

  it("checks the `dark:` variant as part of the whole-bundle pass", () => {
    // Same argument as the override case above: reached through
    // `checkCssOutput` or CI never runs it. The bundle here is otherwise
    // healthy — every required utility present, comfortably over the floor,
    // no forbidden at-rule — and differs from a good one only in the condition
    // the `dark:` rules are emitted under. That is the whole regression.
    const violations = checkCssOutput([
      {
        file: "static/chunks/app.css",
        css: rulesFor(REQUIRED_UTILITIES) + mediaGuardedDarkRules() + FILLER,
      },
    ]);

    expect(violations).toHaveLength(REQUIRED_CLASS_KEYED_DARK.length);
    expect(
      violations.every((v) => v.problem.includes("prefers-color-scheme")),
    ).toBe(true);
  });
});

describe("scanRules", () => {
  it("records a rule with no enclosing at-rule", () => {
    expect(scanRules(".flex{display:flex}")).toEqual([
      { selector: ".flex", atRules: [] },
    ]);
  });

  it("records the at-rules enclosing a rule, outermost first", () => {
    const rules = scanRules(
      "@layer utilities{@media (prefers-color-scheme:dark){.dark\\:bg-red-950{color:red}}}",
    );

    expect(rules).toEqual([
      {
        selector: ".dark\\:bg-red-950",
        atRules: ["@layer utilities", "@media (prefers-color-scheme:dark)"],
      },
    ]);
  });

  it("pops an at-rule when its block closes, so siblings are not tainted", () => {
    // The failure this guards: if the media query stayed on the stack, the
    // rule after it would be reported as media-guarded and the gate would
    // fail a perfectly good build.
    const rules = scanRules(
      "@media (prefers-color-scheme:dark){.a{color:red}}.b{color:blue}",
    );

    expect(rules).toEqual([
      { selector: ".a", atRules: ["@media (prefers-color-scheme:dark)"] },
      { selector: ".b", atRules: [] },
    ]);
  });

  it("handles the nested `@supports` Tailwind emits for an opacity modifier", () => {
    // `bg-red-950/20` compiles to a hex fallback plus a `color-mix` inside
    // `@supports`, so the same selector legitimately appears twice — once at
    // the layer's top level and once two at-rules deep.
    const rules = scanRules(
      "@layer utilities{.o{background-color:#4608}" +
        "@supports (color:color-mix(in lab, red, red)){.o{background-color:color-mix(in oklab,red 20%,transparent)}}}",
    );

    expect(rules.map((r) => r.atRules.length)).toEqual([1, 2]);
  });

  it("does not treat a statement at-rule as an open block", () => {
    // Tailwind emits a bare `@layer components;` before the utilities. Read as
    // a block, it would swallow every rule after it into a phantom frame.
    const rules = scanRules("@layer components;.flex{display:flex}");
    expect(rules).toEqual([{ selector: ".flex", atRules: [] }]);
  });

  it("is not unbalanced by a brace inside a string", () => {
    const rules = scanRules('.a:before{content:"{"}.b{color:red}');
    expect(rules.map((r) => r.selector)).toEqual([".a:before", ".b"]);
  });

  it("ignores declarations, which end at a semicolon", () => {
    const rules = scanRules(":root{--a:1;--b:2}.flex{display:flex}");
    expect(rules.map((r) => r.selector)).toEqual([":root", ".flex"]);
  });
});

describe("splitSelectorList", () => {
  it("splits on top-level commas", () => {
    expect(splitSelectorList(".a, .b")).toEqual([".a", ".b"]);
  });

  it("keeps a comma inside `:where()` with its selector", () => {
    // The condition this file checks for contains a comma of its own; a naive
    // split would cut `:where(.dark, .dark *)` in half and match neither side.
    expect(splitSelectorList(".x:where(.dark, .dark *)")).toEqual([
      ".x:where(.dark, .dark *)",
    ]);
  });

  it("keeps a comma inside an attribute selector", () => {
    expect(splitSelectorList('.x[data-a="1,2"], .y')).toEqual([
      '.x[data-a="1,2"]',
      ".y",
    ]);
  });
});

describe("headsSelector", () => {
  it("matches the utility a rule is built on", () => {
    expect(
      headsSelector(
        ".dark\\:bg-red-950:where(.dark,.dark *)",
        "dark:bg-red-950",
      ),
    ).toBe(true);
  });

  it("does not match an opacity-modified sibling", () => {
    // `dark:bg-red-950` and `dark:bg-red-950/20` are different utilities with
    // different values, and both exist in this codebase. Conflating them would
    // let a requirement for one be satisfied by the other's rule — including
    // its conditions, which is the thing being checked.
    expect(
      headsSelector(
        ".dark\\:bg-red-950\\/20:where(.dark,.dark *)",
        "dark:bg-red-950",
      ),
    ).toBe(false);
  });

  it("does not match a longer utility that merely starts the same", () => {
    expect(headsSelector(".bg-red-9500", "bg-red-950")).toBe(false);
  });

  it("matches a utility anywhere in a selector list, not just the first", () => {
    expect(headsSelector(".other, .flex:where(.dark,.dark *)", "flex")).toBe(
      true,
    );
  });

  it("does not match a utility used only as an ancestor", () => {
    // `hasRule` accepts this — it asks whether the utility appears at all.
    // This asks whether *this* rule is the one generated for it, because the
    // rule's conditions are about to be attributed to that utility.
    expect(headsSelector(".dark .bg-muted", "bg-muted")).toBe(false);
  });
});

describe("checkDarkVariant", () => {
  const ONE = [
    {
      utility: "dark:bg-red-950/20",
      because: "the only one under test",
    },
  ];

  it("passes a class-keyed rule", () => {
    expect(
      checkDarkVariant([{ file: "a.css", css: classKeyedDarkRules(ONE) }], ONE),
    ).toEqual([]);
  });

  it("rejects the media-guarded rule Tailwind's built-in variant emits", () => {
    const violations = checkDarkVariant(
      [{ file: "a.css", css: mediaGuardedDarkRules(ONE) }],
      ONE,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("a.css");
    expect(violations[0]?.problem).toContain("prefers-color-scheme");
    expect(violations[0]?.because).toContain("@custom-variant dark");
  });

  it("rejects a rule that is neither media-guarded nor class-keyed", () => {
    // A variant redefined to key on something else — `[data-theme="dark"]`,
    // an attribute, a third mechanism. Not the built-in variant, so it gets a
    // different message: pointing the reader at `@custom-variant` here would
    // send them to a line that is present and looks fine.
    const violations = checkDarkVariant(
      [
        {
          file: "a.css",
          css: '.dark\\:bg-red-950\\/20[data-theme="dark"]{color:red}',
        },
      ],
      ONE,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("carries no");
    expect(violations[0]?.problem).not.toContain("prefers-color-scheme");
  });

  it("tolerates the whitespace difference between source and minified output", () => {
    // `globals.css` declares `:where(.dark, .dark *)`; the compiler emits
    // `:where(.dark,.dark *)`. Both have to read as the same condition, or the
    // gate fails on a build that is entirely correct.
    for (const condition of [
      ":where(.dark,.dark *)",
      ":where(.dark, .dark *)",
    ]) {
      expect(
        checkDarkVariant(
          [
            {
              file: "a.css",
              css: `.dark\\:bg-red-950\\/20${condition}{color:red}`,
            },
          ],
          ONE,
        ),
      ).toEqual([]);
    }
  });

  it("reports a utility that is missing entirely", () => {
    const violations = checkDarkVariant([{ file: "a.css", css: "" }], ONE);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain(
      "no rule for `.dark:bg-red-950/20`",
    );
  });

  it("checks every rule for a utility, not just the first", () => {
    // An opacity modifier compiles to two rules — a hex fallback and a
    // `color-mix` inside `@supports`. Checking only the first would pass a
    // build where the second lost its condition.
    const violations = checkDarkVariant(
      [
        {
          file: "a.css",
          css:
            ".dark\\:bg-red-950\\/20:where(.dark,.dark *){background-color:#4608}" +
            "@supports (color:color-mix(in lab, red, red)){.dark\\:bg-red-950\\/20{background-color:color-mix(in oklab,red 20%,transparent)}}",
        },
      ],
      ONE,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("carries no");
  });

  it("does not confuse a light utility's rule for the dark one", () => {
    // `bg-red-50` sits right next to `dark:bg-red-950/20` in `image-upload`
    // and is emitted unconditionally, as it should be. It must not be read as
    // the dark rule and reported as unconditioned.
    const violations = checkDarkVariant(
      [
        {
          file: "a.css",
          css:
            ".bg-red-50{background-color:#fef2f2}" + classKeyedDarkRules(ONE),
        },
      ],
      ONE,
    );

    expect(violations).toEqual([]);
  });
});

describe("REQUIRED_CLASS_KEYED_DARK", () => {
  it("names utilities the codebase actually uses", () => {
    // Tailwind generates on demand, so requiring a `dark:` utility nothing
    // references would fail a perfectly healthy build — the same trap the
    // required-utility list documents.
    expect(REQUIRED_CLASS_KEYED_DARK.length).toBeGreaterThan(0);
    for (const { utility } of REQUIRED_CLASS_KEYED_DARK) {
      expect(utility.startsWith("dark:")).toBe(true);
    }
  });

  it("covers a bare utility, an opacity modifier, and stacked variants", () => {
    // The compiler paths that can fail apart. Losing any one of these
    // categories would leave the gate checking a case that already works.
    const utilities = REQUIRED_CLASS_KEYED_DARK.map((d) => d.utility);
    expect(
      utilities.some((u) => !u.includes("/") && !u.includes("hover:")),
    ).toBe(true);
    expect(utilities.some((u) => u.includes("/"))).toBe(true);
    expect(utilities.some((u) => u.includes("hover:"))).toBe(true);
  });

  it("explains every entry", () => {
    for (const { utility, because } of REQUIRED_CLASS_KEYED_DARK) {
      expect(because.length, `${utility} needs a reason`).toBeGreaterThan(40);
    }
  });
});

describe("checkOverrideOrder", () => {
  const PROSE = [
    {
      utility: "prose-app",
      after: "prose",
      because: "the token bindings have to win",
    },
  ];

  it("passes when the override is emitted last", () => {
    expect(
      checkOverrideOrder(
        [{ file: "a.css", css: ".prose{color:blue}.prose-app{color:red}" }],
        PROSE,
      ),
    ).toEqual([]);
  });

  it("fails when the compiler emits the override first", () => {
    const violations = checkOverrideOrder(
      [{ file: "a.css", css: ".prose-app{color:red}.prose{color:blue}" }],
      PROSE,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("a.css");
    expect(violations[0]?.problem).toContain("`.prose` wins");
  });

  it("compares against the last `.prose` rule, not the first", () => {
    // `.prose` heads a long run of descendant selectors — `.prose :where(p)`,
    // `.prose :where(h2)` and so on. Beating only the first of them would
    // leave the plugin's own root rule to be re-applied afterwards.
    const css =
      ".prose{color:blue}" +
      ".prose-app{--tw-prose-body:red}" +
      ".prose :where(p){margin:1em 0}" +
      ".prose{color:green}";

    const violations = checkOverrideOrder([{ file: "a.css", css }], PROSE);
    expect(violations).toHaveLength(1);
  });

  it("does not let descendant selectors alone satisfy the ordering", () => {
    // `.prose :where(p)` sets no `--tw-prose-*` variable, but it is still a
    // `.prose` rule; an override sitting between the root rule and it is
    // fine, which is what this asserts is *not* reported.
    const css =
      ".prose{color:blue}.prose-app{color:red}.prose:hover{color:blue}";
    expect(checkOverrideOrder([{ file: "a.css", css }], PROSE)).toHaveLength(1);
  });

  it("reports when the two rules are not in the same stylesheet", () => {
    const violations = checkOverrideOrder(
      [
        { file: "a.css", css: ".prose{color:blue}" },
        { file: "b.css", css: ".prose-app{color:red}" },
      ],
      PROSE,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("no single stylesheet");
  });

  it("reports a missing override rather than passing it over", () => {
    const violations = checkOverrideOrder(
      [{ file: "a.css", css: ".prose{color:blue}" }],
      PROSE,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain("no single stylesheet");
  });

  it("checks nothing when the list is empty", () => {
    expect(checkOverrideOrder([{ file: "a.css", css: "" }], [])).toEqual([]);
  });
});

describe("REQUIRED_OVERRIDES", () => {
  it("names both sides of every pair in REQUIRED_UTILITIES", () => {
    // An override whose two rules are not independently required would go
    // unnoticed the moment one of them stopped being emitted: the order check
    // reports "not in the same stylesheet", which reads like a build quirk
    // rather than "the typography plugin is gone".
    const required = REQUIRED_UTILITIES.map((r) => r.utility);
    for (const { utility, after } of REQUIRED_OVERRIDES) {
      expect(required, `${utility} must be required`).toContain(utility);
      expect(required, `${after} must be required`).toContain(after);
    }
  });

  it("gives every entry a reason, since that reason is the failure message", () => {
    for (const { utility, after, because } of REQUIRED_OVERRIDES) {
      expect(utility).not.toBe(after);
      expect(because.length, `${utility} needs a reason`).toBeGreaterThan(10);
    }
  });
});

describe("ruleIndices", () => {
  it("returns every occurrence in order", () => {
    expect(ruleIndices(".flex{a}.b{c}.flex{d}", "flex")).toEqual([0, 13]);
  });

  it("returns nothing for a utility that is absent", () => {
    expect(ruleIndices(".flex{a}", "grid")).toEqual([]);
  });

  it("does not count a prefix match", () => {
    expect(ruleIndices(".flex-col{a}", "flex")).toEqual([]);
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
