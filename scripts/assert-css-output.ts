/**
 * Asserts that Tailwind actually compiled into the stylesheet the build wrote.
 *
 * This gate exists because its failure mode is silent in every other check.
 * `@tailwindcss/postcss` sat in devDependencies for weeks with no
 * `postcss.config.*` to reference it, so Next never ran PostCSS and handed
 * `globals.css` straight to Lightning CSS. Lightning CSS resolves
 * `@import "tailwindcss"` as an ordinary import, reads the package's CSS,
 * finds at-rules it has no meaning for, and drops them. No error, no warning.
 * The production bundle was 1,103 bytes — the `:root` custom properties and
 * nothing else — while `next build` exited 0, 223 unit tests passed, and the
 * route-shape gate was satisfied. All 14 routes rendered as unstyled block
 * flow and not one check could see it, because not one check looked at the
 * stylesheet.
 *
 * So the stylesheet is what we assert. The checks are deliberately about the
 * *shape* of a compiled bundle rather than its exact bytes: a byte count would
 * churn on every new class name, and a snapshot would be updated on the way
 * past rather than read.
 *
 * Usage: tsx scripts/assert-css-output.ts [path-to-.next]
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** A stylesheet the build emitted, paired with its contents. */
export interface Stylesheet {
  /** Path as it should be printed on failure, relative to the build dir. */
  file: string;
  css: string;
}

export interface Violation {
  problem: string;
  because: string;
}

/**
 * Utilities that must appear in the compiled output.
 *
 * Every entry is a class this application genuinely uses, so Tailwind's
 * on-demand generation will always emit it — a name nothing referenced would
 * be absent from a perfectly healthy build and make this gate lie.
 *
 * They are chosen to span the parts of the compiler that fail independently:
 * a core utility, the grid and positioning families the `/photos` gallery
 * needs, an arbitrary value, a responsive variant, a state variant, the
 * `@theme inline` colours, and the typography plugin. Losing the `@theme`
 * block, for instance, breaks only that one group — `flex` would still compile
 * and a size floor alone would never notice. The plugin is the same story one
 * level up: `@plugin "@tailwindcss/typography"` is a single line that every
 * other check in this file survives without.
 */
export const REQUIRED_UTILITIES: readonly {
  utility: string;
  because: string;
}[] = [
  { utility: "flex", because: "the most basic layout utility in the app" },
  {
    utility: "grid-cols-3",
    because: "the /photos gallery grid; without it the grid is block flow",
  },
  {
    utility: "absolute",
    because: "positioning; the photo modal overlay depends on it",
  },
  { utility: "rounded-lg", because: "border radius reaches the browser" },
  { utility: "text-sm", because: "the typography scale reaches the browser" },
  {
    utility: "aspect-[3/2]",
    because:
      "arbitrary values are parsed, not just the static utility catalogue",
  },
  {
    utility: "sm:grid-cols-2",
    because: "responsive variants compile; the gallery is unusable without",
  },
  {
    utility: "hover:bg-muted",
    because: "state variants compile",
  },
  {
    utility: "bg-primary",
    because:
      "the `@theme inline` colour namespace; the landing page CTA is invisible without it",
  },
  {
    utility: "text-muted-foreground",
    because: "the `@theme inline` colour namespace, foreground half",
  },
  {
    utility: "ring-border",
    because:
      "the `@theme inline` colour namespace applied through a non-colour property",
  },
  {
    utility: "prose",
    because:
      '`@plugin "@tailwindcss/typography"`; the blog post body is unstyled without it, ' +
      "which is exactly the state it shipped in for the weeks the plugin was named but not installed",
  },
  {
    utility: "prose-app",
    because:
      "the `@utility prose-app` block binding prose's colours to the design tokens; " +
      "without it the post body keeps the plugin's fixed greys and stops following the theme toggle",
  },
];

/**
 * One utility that must be emitted after another, because it overrides it.
 *
 * The cascade normally settles these questions with specificity or layer
 * order, and when it does there is nothing here to assert. This list is for
 * the cases where it does not: two single-class selectors in the same layer,
 * where the only thing deciding the winner is which one the compiler wrote
 * second. That is a property of the build, not of the stylesheet, and it
 * changes without anyone editing CSS.
 */
export const REQUIRED_OVERRIDES: readonly {
  utility: string;
  after: string;
  because: string;
}[] = [
  {
    utility: "prose-app",
    after: "prose",
    because:
      "`@utility prose-app` re-points prose's `--tw-prose-*` variables at the design tokens, and " +
      "both it and the plugin's `.prose` are single class selectors inside `@layer utilities` — " +
      "emission order is the whole of its precedence. Emitted first instead, the post body silently " +
      "reverts to the plugin's fixed greys and stops following the theme toggle, with no other gate affected",
  },
];

/**
 * `dark:` utilities whose compiled rule must key on the `.dark` class.
 *
 * Tailwind v4's built-in `dark:` variant compiles to
 * `@media (prefers-color-scheme: dark)`. This application does not theme by
 * media query — `next-themes` runs with `attribute="class"` and toggles `.dark`
 * on `<html>` — so for as long as the built-in variant was left in place, every
 * utility in this list tracked the operating system and ignored the theme
 * control, in both directions: dark mode left them light, and a dark-mode OS
 * lit them up on a page the user had set to light.
 *
 * `@custom-variant dark (&:where(.dark, .dark *))` in `globals.css` is the one
 * line that redirects them, and losing it is invisible to every other check
 * here: the utilities are all still *emitted*, at the same byte count, so the
 * required-utility list and the size floor stay satisfied. Only the condition
 * they are emitted under changes. That is what this asserts.
 *
 * Every entry is a `dark:` utility this application uses in a `className`.
 * Deliberately not every one it uses: this is a sample chosen to span the
 * compiler paths that can fail apart — a bare colour utility, a fractional
 * opacity modifier, a text colour, and two stacked variants, where `dark:`
 * has to compose with `hover:` rather than sit alone.
 */
export const REQUIRED_CLASS_KEYED_DARK: readonly {
  utility: string;
  because: string;
}[] = [
  {
    utility: "dark:bg-green-900/30",
    because:
      "the published badge in `post-card` and `posts-manager`; on a dark page it renders " +
      "`bg-green-100` — a near-white chip — until the variant keys on the class",
  },
  {
    utility: "dark:text-yellow-400",
    because:
      "the draft badge's foreground, paired with the entry above; a text colour and a " +
      "background colour are separate code paths in the compiler",
  },
  {
    utility: "dark:bg-red-950/20",
    because:
      "the error state of the `image-upload` dropzone, and the one entry carrying an " +
      "opacity modifier — the `/20` compiles through `color-mix`, in its own `@supports` block",
  },
  {
    utility: "dark:hover:bg-green-950",
    because:
      "`toast-demo`'s success button: two stacked variants, where `dark:` has to compose " +
      "with `hover:` instead of standing alone",
  },
  {
    utility: "dark:hover:bg-red-950/20",
    because:
      "the delete button in `posts-manager` — stacked variants *and* an opacity modifier, " +
      "the combination most likely to fall out of whatever handles the simpler cases",
  },
];

/**
 * The selector fragment a class-keyed `dark:` rule must carry.
 *
 * Matched as a substring of the selector rather than by equality, because the
 * compiler appends the rest of the variant chain after it —
 * `.dark\:hover\:bg-green-950:where(.dark,.dark *):hover` — and normalises the
 * whitespace inside the `:where()` as it minifies.
 */
const DARK_CLASS_CONDITION = ":where(.dark,.dark *)";

/**
 * At-rules that must never survive into the output.
 *
 * Their presence is the precise fingerprint of the original bug: Lightning CSS
 * passing Tailwind's own syntax through untouched because nothing expanded it.
 * The broken bundle ended with a literal `@utility primary{…}` — invalid CSS
 * that browsers discard in silence.
 */
export const FORBIDDEN_AT_RULES: readonly string[] = [
  "@tailwind",
  "@utility",
  "@theme",
  "@apply",
  "@source",
  "@custom-variant",
];

/**
 * A bundle smaller than this did not compile Tailwind.
 *
 * A coarse net for failures the utility list does not name — a preflight-only
 * build, or a `source()` pointing somewhere with no components in it. The real
 * bundle is ~34 KB and the broken one was 1.1 KB, so the exact threshold does
 * not matter much; it is set well below the healthy size so ordinary churn
 * never trips it, and well above anything that could be called compiled.
 */
export const MINIMUM_BUNDLE_BYTES = 15_000;

/**
 * Finds a class rule in compiled CSS.
 *
 * Tailwind escapes every character that is not selector-safe, so `hover:bg-muted`
 * is written `.hover\:bg-muted` and `aspect-[3/2]` is written
 * `.aspect-\[3\/2\]`. Stripping backslashes before matching lets callers name
 * utilities the way they appear in `className`, which is the only spelling
 * anyone maintaining this list will have in mind.
 *
 * The lookahead is what stops `.flex` from being satisfied by `.flex-col`:
 * a class selector ends at a combinator, a comma, the declaration block, a
 * pseudo-class, or the start of a compound selector.
 */
export function hasRule(css: string, utility: string): boolean {
  return ruleIndices(css, utility).length > 0;
}

/**
 * Every offset at which `utility` heads a selector, in emission order.
 *
 * Offsets are into the *unescaped* copy of the stylesheet, so they are only
 * ever meaningful against other offsets from the same call site — which is all
 * the override check compares.
 */
export function ruleIndices(css: string, utility: string): number[] {
  const unescaped = css.replaceAll("\\", "");
  const pattern = new RegExp(
    escapeRegExp(`.${utility}`) + String.raw`(?=[,{:>~+\s.\[])`,
    "g",
  );
  return [...unescaped.matchAll(pattern)].map((match) => match.index);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** A style rule found in compiled CSS, with the at-rules enclosing it. */
export interface CssRule {
  /** The selector as written, escapes intact. */
  selector: string;
  /** Preludes of the enclosing at-rules, outermost first. */
  atRules: string[];
}

/**
 * Lists every style rule in a stylesheet alongside the at-rules wrapping it.
 *
 * The other checks in this file only ask whether a rule exists, which a
 * substring search answers. The `dark:` check asks something a substring search
 * cannot: *under what condition* a rule applies. `.dark\:bg-green-900\/30` is
 * present either way — the difference between tracking the theme toggle and
 * tracking the operating system is whether an
 * `@media (prefers-color-scheme: dark)` sits above it, which means knowing
 * where the block boundaries are.
 *
 * Deliberately not a CSS parser. It tracks brace depth, remembers which frames
 * were opened by an at-rule, and skips over quoted strings so a `content: "{"`
 * cannot unbalance it. Declarations end at a `;` and are discarded; a prelude
 * ending at a `{` is either an at-rule to push or a selector to record.
 * Anything more than that belongs to a real parser, and nothing here needs one.
 */
export function scanRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  /** Preludes of the enclosing at-rules, outermost first. */
  const atRules: string[] = [];
  /** One entry per open brace: whether an at-rule opened it. */
  const frames: boolean[] = [];
  let prelude = "";
  let quote: string | null = null;
  /** The character before the one being read, for the escape check below. */
  let previous = "";

  for (const char of css) {
    const preceding = previous;
    previous = char;

    if (quote !== null) {
      if (char === quote && preceding !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "{") {
      if (prelude.startsWith("@")) {
        atRules.push(prelude);
        frames.push(true);
      } else {
        if (prelude !== "")
          rules.push({ selector: prelude, atRules: [...atRules] });
        frames.push(false);
      }
      prelude = "";
      continue;
    }
    if (char === "}") {
      if (frames.pop() === true) atRules.pop();
      prelude = "";
      continue;
    }
    // A declaration, or a statement at-rule like Tailwind's `@layer components;`.
    if (char === ";") {
      prelude = "";
      continue;
    }

    // Leading whitespace is dropped so `prelude` starts at the first real
    // character; `@media(…)` and `@media (…)` both have to read as at-rules.
    if (prelude === "" && /\s/.test(char)) continue;
    prelude += char;
  }

  return rules;
}

/**
 * Splits a selector list on its top-level commas.
 *
 * Paren-aware, because the condition this file is checking for contains a comma
 * of its own: `:where(.dark, .dark *)` is one selector, not two.
 */
export function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (const char of selector) {
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;

    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());

  return parts.filter((part) => part !== "");
}

/**
 * Whether `utility` is the class a selector is built on.
 *
 * Stricter than `hasRule`: that asks whether a utility appears anywhere in the
 * stylesheet, while this asks whether *this* rule is the one generated for it,
 * so that the rule's conditions can be attributed to that utility and nothing
 * else. `/` is pointedly absent from the terminator set — otherwise a
 * requirement for `dark:bg-red-950` would be satisfied by the rule for
 * `dark:bg-red-950/20`, which is a different utility with a different value.
 */
export function headsSelector(selector: string, utility: string): boolean {
  return splitSelectorList(selector).some((part) => {
    const unescaped = part.replaceAll("\\", "");
    if (!unescaped.startsWith(`.${utility}`)) return false;
    const next = unescaped[utility.length + 1];
    return next === undefined || /[,{:>~+\s.[]/.test(next);
  });
}

/** Whitespace carries no meaning in the fragment being compared, and minifiers move it. */
function squashWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

/**
 * Checks that each `dark:` utility applies under the `.dark` class.
 *
 * Two failures, reported apart because they read as different problems. A rule
 * wrapped in `prefers-color-scheme` is the specific regression this exists for
 * — the built-in variant, back in place because the `@custom-variant`
 * declaration went missing — and gets named as such. A rule that is neither
 * media-guarded nor class-keyed is something else entirely: a variant redefined
 * to key on an attribute, a `data-theme` selector, some third mechanism. Both
 * mean the utility no longer follows the toggle, which is what the gate is
 * about, but conflating them would send the next reader looking for the wrong
 * line.
 */
export function checkDarkVariant(
  stylesheets: readonly Stylesheet[],
  utilities: readonly {
    utility: string;
    because: string;
  }[] = REQUIRED_CLASS_KEYED_DARK,
): Violation[] {
  const violations: Violation[] = [];
  const condition = squashWhitespace(DARK_CLASS_CONDITION);

  for (const { utility, because } of utilities) {
    const matches = stylesheets.flatMap((sheet) =>
      scanRules(sheet.css)
        .filter((rule) => headsSelector(rule.selector, utility))
        .map((rule) => ({ sheet, rule })),
    );

    if (matches.length === 0) {
      violations.push({
        problem: `no rule for \`.${utility}\` in any emitted stylesheet.`,
        because,
      });
      continue;
    }

    for (const { sheet, rule } of matches) {
      const mediaGuard = rule.atRules.find((at) =>
        at.includes("prefers-color-scheme"),
      );

      if (mediaGuard !== undefined) {
        violations.push({
          problem:
            `${sheet.file} emits \`.${utility}\` inside \`${mediaGuard}\`, so it follows the ` +
            "operating system and ignores the theme toggle. A media query cannot be overridden " +
            "by a class, so the toggle has no way to reach it.",
          because:
            `${because}. This is Tailwind's built-in \`dark:\` variant — ` +
            "`@custom-variant dark (&:where(.dark, .dark *))` in `globals.css` is what redirects it " +
            "at the class `next-themes` toggles",
        });
        continue;
      }

      if (!squashWhitespace(rule.selector).includes(condition)) {
        violations.push({
          problem:
            `${sheet.file} emits \`.${utility}\` as \`${rule.selector}\`, which carries no ` +
            `\`${DARK_CLASS_CONDITION}\` condition, so it does not key on the class \`next-themes\` toggles.`,
          because: `${because}. The \`dark:\` variant is defined in \`globals.css\` and must resolve to that class`,
        });
      }
    }
  }

  return violations;
}

/**
 * Compares the emitted stylesheets against the expectations above.
 *
 * Pure and content-shaped rather than reading from disk, so the tests can
 * describe a regressed bundle — including the exact 1,103-byte one this gate
 * was written for — without running a build.
 */
export function checkCssOutput(
  stylesheets: readonly Stylesheet[],
  required: readonly {
    utility: string;
    because: string;
  }[] = REQUIRED_UTILITIES,
  overrides: readonly {
    utility: string;
    after: string;
    because: string;
  }[] = REQUIRED_OVERRIDES,
  darkUtilities: readonly {
    utility: string;
    because: string;
  }[] = REQUIRED_CLASS_KEYED_DARK,
): Violation[] {
  const violations: Violation[] = [];

  if (stylesheets.length === 0) {
    return [
      {
        problem: "the build wrote no stylesheet at all.",
        because:
          "`src/styles/globals.css` is imported by the root layout, so every build must emit CSS",
      },
    ];
  }

  const combined = stylesheets.map((sheet) => sheet.css).join("\n");
  const totalBytes = Buffer.byteLength(combined, "utf8");

  if (totalBytes < MINIMUM_BUNDLE_BYTES) {
    violations.push({
      problem:
        `the emitted CSS totals ${totalBytes} bytes across ${stylesheets.length} file(s), ` +
        `below the ${MINIMUM_BUNDLE_BYTES}-byte floor. A compiled bundle for this application is ~34 KB; ` +
        '1,103 bytes is what it measured when `@import "tailwindcss"` was resolved and discarded.',
      because:
        "a bundle this small carries the custom properties and none of the utilities",
    });
  }

  for (const sheet of stylesheets) {
    for (const atRule of FORBIDDEN_AT_RULES) {
      if (sheet.css.includes(atRule)) {
        violations.push({
          problem: `${sheet.file} still contains a literal \`${atRule}\` at-rule.`,
          because:
            "Tailwind's own syntax reaching the browser means something copied the stylesheet " +
            "through instead of compiling it — the exact shape of the original bug",
        });
      }
    }
  }

  for (const { utility, because } of required) {
    if (!hasRule(combined, utility)) {
      violations.push({
        problem: `no rule for \`.${utility}\` in any emitted stylesheet.`,
        because,
      });
    }
  }

  violations.push(...checkOverrideOrder(stylesheets, overrides));
  violations.push(...checkDarkVariant(stylesheets, darkUtilities));

  return violations;
}

/**
 * Checks that each override is emitted after the rule it overrides.
 *
 * Both rules have to be in the same stylesheet for the question to have an
 * answer: two files are applied in the order the document links them, which
 * this script cannot see. In practice the build emits one stylesheet, so
 * finding them apart means something about the output changed shape and the
 * precedence is no longer being checked at all — reported rather than passed
 * over, since a gate that quietly stops looking is how the CSS got here.
 *
 * Both offsets come from the last occurrence of each selector. A utility can
 * head more than one rule — `.prose` also opens the descendant selectors that
 * style its children — and it is the last of them that a later rule has to
 * beat.
 */
export function checkOverrideOrder(
  stylesheets: readonly Stylesheet[],
  overrides: readonly {
    utility: string;
    after: string;
    because: string;
  }[] = REQUIRED_OVERRIDES,
): Violation[] {
  const violations: Violation[] = [];

  for (const { utility, after, because } of overrides) {
    const sheet = stylesheets.find(
      (candidate) =>
        hasRule(candidate.css, utility) && hasRule(candidate.css, after),
    );

    if (!sheet) {
      violations.push({
        problem:
          `no single stylesheet carries both \`.${utility}\` and \`.${after}\`, ` +
          "so which one wins cannot be determined from the output.",
        because,
      });
      continue;
    }

    const overrideAt = lastIndexOfRule(sheet.css, utility);
    const overriddenAt = lastIndexOfRule(sheet.css, after);

    if (overrideAt < overriddenAt) {
      violations.push({
        problem:
          `${sheet.file} emits \`.${utility}\` before \`.${after}\`, so \`.${after}\` wins. ` +
          "Equal specificity, same cascade layer — the later rule is the one that applies.",
        because,
      });
    }
  }

  return violations;
}

function lastIndexOfRule(css: string, utility: string): number {
  const indices = ruleIndices(css, utility);
  return indices[indices.length - 1] ?? -1;
}

/**
 * Reads every stylesheet the build wrote.
 *
 * `.next/cache` is excluded: it holds Turbopack's intermediate artefacts,
 * which include copies of source CSS that would satisfy these checks without
 * anything having been served to a browser.
 */
export function readStylesheets(nextDir: string): Stylesheet[] {
  const sheets: Stylesheet[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "cache") continue;
        walk(full);
      } else if (entry.name.endsWith(".css")) {
        sheets.push({
          file: path.relative(nextDir, full),
          css: readFileSync(full, "utf8"),
        });
      }
    }
  };

  walk(path.join(nextDir, "static"));
  return sheets;
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map((v) => `  ${v.problem}\n    expected because: ${v.because}`)
    .join("\n\n");
}

function main(argv: readonly string[]): number {
  const nextDir = argv[0] ?? ".next";
  const stylesheets = readStylesheets(nextDir);
  const violations = checkCssOutput(stylesheets);

  if (violations.length > 0) {
    console.error(
      `Tailwind did not compile — ${violations.length} problem(s) with the emitted CSS:\n\n` +
        `${formatViolations(violations)}\n\n` +
        "The usual cause is a missing or unreadable `postcss.config.mjs`: Next only runs\n" +
        "PostCSS when one is present at the project root, and silently falls back to\n" +
        "Lightning CSS — which drops every Tailwind directive — when it is not.\n",
    );
    return 1;
  }

  const bytes = stylesheets.reduce(
    (sum, sheet) => sum + Buffer.byteLength(sheet.css, "utf8"),
    0,
  );
  console.log(
    `CSS output OK — ${bytes} bytes across ${stylesheets.length} stylesheet(s), ` +
      `${REQUIRED_UTILITIES.length} required utilities present, ` +
      `${REQUIRED_OVERRIDES.length} override(s) in the right order, ` +
      `${REQUIRED_CLASS_KEYED_DARK.length} \`dark:\` utilities keyed on the class.`,
  );
  return 0;
}

/* c8 ignore start -- CLI entry; the logic above is what the tests exercise. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
/* c8 ignore stop */
