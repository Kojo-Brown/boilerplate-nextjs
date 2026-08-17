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
      `${REQUIRED_OVERRIDES.length} override(s) in the right order.`,
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
