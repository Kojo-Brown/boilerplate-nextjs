/**
 * Asserts that no component positions itself with a physical direction.
 *
 * This gate is the half of the RTL work that outlives the commit that did it.
 * Converting `ml-4` to `ms-4` across the tree is an afternoon; keeping it
 * converted is the problem, because a physical utility is invisible in the only
 * locale most contributors will ever look at. `ml-4` and `ms-4` render
 * identically in English — identical pixels, identical screenshots, identical
 * axe output — and differ only once the document is `dir="rtl"`. So a new
 * `mr-2` or `text-left` is a change that looks right, tests right, and reviews
 * right, and silently puts a margin on the wrong side of the one locale nobody
 * on the team reads.
 *
 * `ar` is in `LOCALES` precisely so that failure is reachable. This gate is so
 * that it is reachable *at review time* rather than by an Arabic-speaking
 * visitor.
 *
 * ## Why tokens from string literals, and not a grep
 *
 * Two false positives sink a naive regex, and both are in this repository:
 *
 * - `rounded-lg` contains `rounded-l`, and `border-e` would be a nonsense
 *   replacement for it. Matching whole whitespace-delimited tokens rather than
 *   substrings is what tells the two apart.
 * - Prose names these utilities. The header you are reading is full of
 *   `ml-4`/`text-left`, and `src/i18n/locales.ts` mentions them too. Scanning
 *   only the contents of string literals — which is where a class name can
 *   actually be — skips every comment by construction, so documenting the rule
 *   cannot break the rule.
 *
 * ## What is deliberately still allowed
 *
 * `left-1/2` and `right-1/2` are centring idioms: paired with
 * `-translate-x-1/2` they are symmetric about the centre and behave the same in
 * both directions. Their logical spellings are the ones that break — `start-1/2`
 * resolves to `right: 50%` under RTL while `-translate-x-1/2` still pulls
 * leftward, which moves a centred dialog off-screen. `inset-x-*` is symmetric
 * and needs no logical form. `translate-x-*` is not flipped by `dir` at all, so
 * banning it here would imply a logical alternative that does not exist.
 *
 * Usage: tsx scripts/assert-logical-properties.ts [path-to-src]
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export interface Violation {
  /** Path as it should be printed, relative to the scanned root's parent. */
  file: string;
  /** 1-based line number the token is on. */
  line: number;
  /** The offending class token, with its variants as written. */
  token: string;
  /** What to write instead. */
  instead: string;
}

/**
 * The shape of a Tailwind utility value.
 *
 * This is what separates a class from a sentence, and it is load-bearing. The
 * first version of this gate matched `^right-(.+)$`, which is also the shape of
 * the English phrase "right-to-left" — so a test named `"reads right-to-left"`
 * failed the build and the suggested fix was `end-to-left`. Any string literal
 * is fair game for the scan, and plenty of them are prose containing a
 * hyphenated direction word.
 *
 * So a value has to look like one: a number (`4`, `0.5`), a fraction (`1/2`), a
 * scale keyword, an arbitrary `[…]` value, or a `(--var)` reference. `to-left`
 * is none of those, and neither is `aligned`.
 */
const VALUE = String.raw`(?:\[[^\]]*\]|\([^)]*\)|\d+(?:\.\d+)?(?:\/\d+)?|auto|full|px|screen|min|max|fit|none|reverse|xs|sm|md|lg|xl|[2-9]xl)`;

/** One banned utility family. */
interface Rule {
  /** Matched against the base token — variants and a negative sign removed. */
  pattern: RegExp;
  /**
   * The logical utility. A captured value is appended to it, so `ms` becomes
   * `ms-4` for `ml-4` and `border-s` stays `border-s` for a bare `border-l`.
   */
  instead: string;
  /** Appended to the advice when the replacement needs more than a rename. */
  note?: string;
}

/** A family whose value is required: `ml-4`, never a bare `ml`. */
function valued(prefix: string, instead: string, note?: string): Rule {
  return {
    pattern: new RegExp(String.raw`^${prefix}-(${VALUE})$`, "u"),
    instead,
    ...(note && { note }),
  };
}

/** A family that is valid bare or with a value: `border-l`, `border-l-2`. */
function optionallyValued(
  prefix: string,
  instead: string,
  note?: string,
): Rule {
  return {
    pattern: new RegExp(String.raw`^${prefix}(?:-(${VALUE}))?$`, "u"),
    instead,
    ...(note && { note }),
  };
}

/** A family with no value at all: `text-left`. */
function exact(token: string, instead: string): Rule {
  return { pattern: new RegExp(String.raw`^${token}$`, "u"), instead };
}

/**
 * The physical utilities, and what replaces each.
 *
 * Only families with a real logical counterpart in Tailwind are listed. A rule
 * whose advice is "restructure this" rather than "write that instead" belongs
 * in review, not in a gate that has to be mechanically satisfiable — which is
 * why the two that do need restructuring carry a `note`.
 */
export const RULES: readonly Rule[] = [
  valued("ml", "ms"),
  valued("mr", "me"),
  valued("pl", "ps"),
  valued("pr", "pe"),
  valued("scroll-ml", "scroll-ms"),
  valued("scroll-mr", "scroll-me"),
  valued("scroll-pl", "scroll-ps"),
  valued("scroll-pr", "scroll-pe"),
  valued("left", "start"),
  valued("right", "end"),
  optionallyValued("border-l", "border-s"),
  optionallyValued("border-r", "border-e"),
  optionallyValued("rounded-l", "rounded-s"),
  optionallyValued("rounded-r", "rounded-e"),
  optionallyValued("rounded-tl", "rounded-ss"),
  optionallyValued("rounded-tr", "rounded-se"),
  optionallyValued("rounded-bl", "rounded-es"),
  optionallyValued("rounded-br", "rounded-ee"),
  exact("text-left", "text-start"),
  exact("text-right", "text-end"),
  exact("float-left", "float-start"),
  exact("float-right", "float-end"),
  exact("clear-left", "clear-start"),
  exact("clear-right", "clear-end"),
  valued("space-x", "gap-x", "on a flex or grid parent"),
  optionallyValued("divide-x", "border-s", "on each child"),
];

/**
 * Tokens that match a rule and are nevertheless correct.
 *
 * See the header: these are symmetric centring idioms whose logical spellings
 * are the broken ones.
 */
export const ALLOWED = new Set(["left-1/2", "right-1/2"]);

/** Extensions worth scanning: the ones that can carry a `className`. */
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx"]);

/**
 * The contents of every string literal in `source`, one entry per literal,
 * paired with the line it starts on.
 *
 * A hand-rolled scanner rather than a parser because the question is this
 * small: which byte ranges are string literals, and which are comments. It
 * tracks single, double and template quoting and both comment forms, and
 * handles backslash escapes inside literals.
 *
 * A template literal's `${…}` expression is returned as part of its text. That
 * is deliberate — it costs nothing (an identifier is not a banned token) and
 * avoids having to track nested quoting inside interpolations, which is where a
 * scanner this size would start getting it wrong.
 */
export function extractStringLiterals(
  source: string,
): { text: string; line: number }[] {
  const literals: { text: string; line: number }[] = [];
  let state: "code" | "line-comment" | "block-comment" | "string" = "code";
  let quote = "";
  let buffer = "";
  let startLine = 1;
  let line = 1;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    const next = source[index + 1];

    if (char === "\n") line += 1;

    switch (state) {
      case "code":
        if (char === "/" && next === "/") {
          state = "line-comment";
          index += 1;
        } else if (char === "/" && next === "*") {
          state = "block-comment";
          index += 1;
        } else if (char === '"' || char === "'" || char === "`") {
          state = "string";
          quote = char;
          buffer = "";
          startLine = line;
        }
        break;

      case "line-comment":
        if (char === "\n") state = "code";
        break;

      case "block-comment":
        if (char === "*" && next === "/") {
          state = "code";
          index += 1;
        }
        break;

      case "string":
        if (char === "\\") {
          // Consume the escaped character so `\"` does not close the literal,
          // and keep it, because dropping it would join the tokens either side.
          // `"ml-4\nmr-2"` is two classes: emitting the escape as whitespace
          // keeps them two, while discarding it would produce the single
          // unrecognised token `ml-4mr-2` and miss both violations.
          const escaped = source[index + 1];
          buffer +=
            escaped === undefined || "ntrv0bf".includes(escaped)
              ? " "
              : escaped;
          index += 1;
        } else if (char === quote) {
          literals.push({ text: buffer, line: startLine });
          state = "code";
        } else {
          buffer += char;
        }
        break;
    }
  }

  return literals;
}

/**
 * The base of a class token: variants and a leading negative sign removed.
 *
 * `sm:focus:-ml-4` is `ml-4`. Variants are stripped at the last colon because
 * they stack, and the sign is stripped after them because Tailwind writes it
 * inside the variant chain (`sm:-ml-4`, never `-sm:ml-4`).
 */
export function baseToken(token: string): string {
  return splitToken(token).base;
}

/**
 * A token's variant chain, negative sign and bare utility.
 *
 * Kept apart rather than discarded because the advice is pasted: suggesting
 * `me-2` for `sm:-mr-2` is correct about the utility and wrong about the line,
 * and a developer who takes it loses the breakpoint. The suggestion is
 * reassembled from these three parts so it is a drop-in replacement.
 */
function splitToken(token: string): {
  variants: string;
  sign: string;
  base: string;
} {
  const boundary = token.lastIndexOf(":") + 1;
  const variants = token.slice(0, boundary);
  const rest = token.slice(boundary);
  const sign = rest.startsWith("-") ? "-" : "";

  return { variants, sign, base: rest.slice(sign.length) };
}

/** The logical replacement for `token`, or `undefined` if it is already fine. */
export function physicalViolation(token: string): string | undefined {
  const { variants, sign, base } = splitToken(token);
  if (ALLOWED.has(base)) return undefined;

  for (const { pattern, instead, note } of RULES) {
    const match = pattern.exec(base);
    if (!match) continue;

    // The value is absent for the bare forms (`border-l`, `divide-x`), which is
    // what lets one rule cover both `border-l` and `border-l-2`.
    const value = match[1];
    const utility = value === undefined ? instead : `${instead}-${value}`;
    const replacement = `${variants}${sign}${utility}`;
    return note ? `${replacement} ${note}` : replacement;
  }

  return undefined;
}

/** Every violation in one file's source. */
export function checkSource(file: string, source: string): Violation[] {
  const violations: Violation[] = [];

  for (const { text, line } of extractStringLiterals(source)) {
    for (const token of text.split(/\s+/u)) {
      if (token.length === 0) continue;

      const instead = physicalViolation(token);
      if (instead) {
        violations.push({ file, line, token, instead });
      }
    }
  }

  return violations;
}

/** Every scannable file under `root`, depth-first and sorted. */
export function sourceFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const entryPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...sourceFiles(entryPath));
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map(
      ({ file, line, token, instead }, index) =>
        `  ${index + 1}. ${file}:${line} — \`${token}\` → write \`${instead}\` instead`,
    )
    .join("\n");
}

function main(argv: readonly string[]): number {
  const root = argv[0] ?? "src";
  const files = sourceFiles(root);
  const violations = files.flatMap((file) =>
    checkSource(file, readFileSync(file, "utf8")),
  );

  if (violations.length > 0) {
    console.error(
      `Physical direction in ${violations.length} place(s):\n\n` +
        `${formatViolations(violations)}\n\n` +
        "These render identically in English and put the spacing on the wrong side in\n" +
        "Arabic, which is in `LOCALES`. The logical utilities follow the document's\n" +
        "`dir`, so one spelling is correct in both. See docs/i18n.md.\n",
    );
    return 1;
  }

  console.log(
    `Logical properties OK — ${files.length} file(s) scanned, ` +
      `${RULES.length} physical utility families rejected, ` +
      `${ALLOWED.size} centring idiom(s) allowed.`,
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
