/**
 * Asserts that every locale's message catalogue is complete, parses, and
 * pluralises the way its own language does.
 *
 * This gate exists because a wrong translation is invisible to every other
 * check in this repository. A catalogue is a JSON file: it has no types to
 * violate, no imports to resolve and no code path to cover, so `tsc`, ESLint,
 * the unit suite and the build all pass over it without an opinion. The three
 * ways it goes wrong are these, and none of them is a crash:
 *
 * 1. **A missing key.** `next-intl` renders the key path itself — a visitor
 *    sees `posts.recentTitle` where a heading should be. Nothing throws.
 * 2. **A flattened plural.** Someone translating from the English file writes
 *    `"count": "# منشورات"` instead of the ICU `plural` block. Every count
 *    renders the same form, and `#` is emitted literally because there is no
 *    plural argument to substitute into.
 * 3. **A plural with the wrong categories** — the sharp one, and the reason
 *    `ar` is the second locale. English has two CLDR plural categories (`one`,
 *    `other`); Arabic has six (`zero`, `one`, `two`, `few`, `many`, `other`).
 *    An `ar` catalogue carrying English's two branches is well-formed ICU, it
 *    formats without error, and it is grammatically wrong for 2, 3 and 11 —
 *    which all fall through to `other`. There is no type, no test and no render
 *    that notices, because the output is a plausible string.
 *
 * So the catalogues are what we assert, against the default locale for their
 * shape and against CLDR for their plural branches.
 *
 * ## The one heuristic, and its limits
 *
 * Deciding which plural categories a message *declares* needs the message's
 * AST. The parser that `next-intl` formats with
 * (`@formatjs/icu-messageformat-parser`) is a transitive dependency, not a
 * declared one, and pnpm's layout rightly refuses an undeclared import — so
 * declaring it here, purely for this gate, would add a direct dependency on a
 * package the application never calls. Instead the branch names are read off
 * the message source with `DECLARED_CATEGORY` below: the six CLDR keywords are
 * a closed set, and a keyword immediately followed by `{` inside a message that
 * already contains a `plural` argument is a branch selector with no realistic
 * alternative reading.
 *
 * What that buys and what it costs is worth being precise about. It can in
 * principle over-report — literal prose reading `...one {` inside a plural
 * message would be counted as a branch — which would make the gate *more*
 * permissive, never break a correct build. It cannot under-report for any
 * message a translator would actually write, because a declared branch is
 * spelled exactly that way. The second check below closes the gap from the
 * other side regardless: every required category is also *formatted*, with a
 * number CLDR assigns to it, through `next-intl`'s own translator. A message
 * that this scan misread still has to produce output for all six.
 *
 * Usage: tsx scripts/assert-i18n-catalogues.ts [path-to-messages-dir]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createTranslator } from "next-intl";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "../src/i18n/locales";

/**
 * A catalogue as it sits on disk: nested objects down to string leaves.
 *
 * `next-intl` allows arbitrary nesting and this gate does not care how deep a
 * namespace goes, only that the two catalogues agree about it — so the shape is
 * recursive rather than a fixed depth.
 */
export type Catalogue = {
  readonly [key: string]: string | Catalogue;
};

export interface Violation {
  /** The locale the problem is in. */
  locale: Locale;
  /** Dot-separated key path, or `"(catalogue)"` for a whole-file problem. */
  key: string;
  problem: string;
  because: string;
}

/** The CLDR plural categories, as `Intl.PluralRules` names them. */
const CLDR_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;

type PluralCategory = (typeof CLDR_CATEGORIES)[number];

/**
 * A branch selector in an ICU `plural`/`selectordinal` argument.
 *
 * Anchored on the `{` that opens the branch body, which is what distinguishes
 * `one {…}` from the word "one" appearing in a translation. See the header for
 * why this is a scan rather than a parse.
 */
const DECLARED_CATEGORY = new RegExp(
  String.raw`\b(${CLDR_CATEGORIES.join("|")})\s*\{`,
  "gu",
);

/** Does this message contain a cardinal `plural` argument? */
const HAS_PLURAL = /,\s*plural\s*,/u;

/** Does this message contain an ordinal `selectordinal` argument? */
const HAS_SELECTORDINAL = /,\s*selectordinal\s*,/u;

/**
 * Every leaf path in a catalogue, dot-separated and sorted.
 *
 * Sorted because the output is compared and printed: an unsorted diff of two
 * key lists is unreadable, and a catalogue's key order is not something a
 * translator should have to preserve.
 */
export function flattenKeys(catalogue: Catalogue, prefix = ""): string[] {
  const keys: string[] = [];

  for (const [key, value] of Object.entries(catalogue)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      keys.push(keyPath);
    } else {
      keys.push(...flattenKeys(value, keyPath));
    }
  }

  return keys.sort();
}

/** The string at a dot-separated path, or `undefined` if it is absent. */
export function messageAt(
  catalogue: Catalogue,
  keyPath: string,
): string | undefined {
  let node: string | Catalogue | undefined = catalogue;

  for (const segment of keyPath.split(".")) {
    if (typeof node !== "object") return undefined;
    node = node[segment];
  }

  return typeof node === "string" ? node : undefined;
}

/**
 * The plural categories `locale` actually distinguishes, per CLDR.
 *
 * Read from `Intl.PluralRules` rather than written down: the rules are the
 * runtime's, so a table here would be a second copy of CLDR that could disagree
 * with the one doing the formatting.
 */
export function requiredCategories(
  locale: string,
  type: "cardinal" | "ordinal" = "cardinal",
): PluralCategory[] {
  const categories = new Intl.PluralRules(locale, {
    type,
  }).resolvedOptions().pluralCategories;

  // Ordered as CLDR_CATEGORIES is, so failure messages read the same way every
  // time rather than in whatever order the runtime happens to report.
  return CLDR_CATEGORIES.filter((category) =>
    (categories as readonly string[]).includes(category),
  );
}

/** The plural branch names a message declares. */
export function declaredCategories(message: string): Set<PluralCategory> {
  const declared = new Set<PluralCategory>();

  for (const [, category] of message.matchAll(DECLARED_CATEGORY)) {
    declared.add(category as PluralCategory);
  }

  return declared;
}

/**
 * A number `locale` assigns to `category`, for formatting the message with.
 *
 * Found by search rather than by table for the same reason `requiredCategories`
 * is: CLDR decides, and only the runtime knows what it decided. Integers first
 * because every category that has an integer member is more readable in a
 * failure message with one; the fractional candidates exist because a few
 * languages reach `other` only through a non-integer.
 */
export function representativeFor(
  locale: string,
  category: PluralCategory,
  type: "cardinal" | "ordinal" = "cardinal",
): number | undefined {
  const rules = new Intl.PluralRules(locale, { type });

  for (let candidate = 0; candidate <= 200; candidate += 1) {
    if (rules.select(candidate) === category) return candidate;
  }

  for (const candidate of [0.5, 1.5, 2.5, 1.1]) {
    if (rules.select(candidate) === category) return candidate;
  }

  return undefined;
}

/**
 * Formats one message for one count, and reports what went wrong if anything
 * did.
 *
 * Goes through `createTranslator` — the same entry point the application
 * renders with, so an ICU construct this gate accepts is one `next-intl`
 * accepts. A thrown error here is a message that would have thrown in a page.
 */
function formatFailure(
  locale: Locale,
  keyPath: string,
  message: string,
  count: number,
): string | undefined {
  try {
    const translate = createTranslator({
      locale,
      messages: { message },
      // The default handler reports a missing message by calling `console.error`
      // and returning the key, which would turn a formatting problem into a
      // silent pass with noise on stderr. Throwing makes it this function's
      // problem, which is the point of calling it.
      onError: (error) => {
        throw error;
      },
    });

    const rendered = translate("message", { count });
    return rendered.length === 0 ? "formatted to an empty string" : undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Every problem across every catalogue.
 *
 * Takes the already-parsed catalogues rather than reading them, so the tests
 * can hand it a deliberately broken pair without writing files.
 */
export function checkCatalogues(
  catalogues: Readonly<Partial<Record<Locale, Catalogue>>>,
): Violation[] {
  const violations: Violation[] = [];
  const reference = catalogues[DEFAULT_LOCALE];

  if (!reference) {
    return [
      {
        locale: DEFAULT_LOCALE,
        key: "(catalogue)",
        problem: `no catalogue for the default locale \`${DEFAULT_LOCALE}\``,
        because:
          "every other catalogue is compared against it, so there is nothing to check without it",
      },
    ];
  }

  const referenceKeys = flattenKeys(reference);

  for (const locale of LOCALES) {
    const catalogue = catalogues[locale];

    if (!catalogue) {
      violations.push({
        locale,
        key: "(catalogue)",
        problem: `\`messages/${locale}.json\` is missing`,
        because: `\`${locale}\` is in LOCALES, so every page it serves would render key paths instead of text`,
      });
      continue;
    }

    const keys = flattenKeys(catalogue);

    for (const key of referenceKeys) {
      if (!keys.includes(key)) {
        violations.push({
          locale,
          key,
          problem: "missing",
          because: `\`${DEFAULT_LOCALE}\` has it, so next-intl would render the key path "${key}" to the visitor`,
        });
      }
    }

    for (const key of keys) {
      if (!referenceKeys.includes(key)) {
        violations.push({
          locale,
          key,
          problem: "not in the default catalogue",
          because: `\`${DEFAULT_LOCALE}\` does not have it, so nothing reads it — it is either a typo or a string that was never wired up`,
        });
      }
    }

    // Plural shape, per key the reference and this locale both have.
    for (const key of referenceKeys) {
      const referenceMessage = messageAt(reference, key);
      const message = messageAt(catalogue, key);
      if (referenceMessage === undefined || message === undefined) continue;

      for (const [kind, pattern, type] of [
        ["plural", HAS_PLURAL, "cardinal"],
        ["selectordinal", HAS_SELECTORDINAL, "ordinal"],
      ] as const) {
        if (!pattern.test(referenceMessage)) continue;

        if (!pattern.test(message)) {
          violations.push({
            locale,
            key,
            problem: `is not a \`${kind}\` message, but \`${DEFAULT_LOCALE}\` is`,
            because:
              "a flattened plural renders one form for every count, and emits `#` literally because there is no plural argument to substitute",
          });
          continue;
        }

        const required = requiredCategories(locale, type);
        const declared = declaredCategories(message);
        const missing = required.filter((category) => !declared.has(category));

        if (missing.length > 0) {
          violations.push({
            locale,
            key,
            problem: `declares no \`${missing.join("`, `")}\` branch`,
            because:
              `CLDR gives \`${locale}\` the ${kind} categories \`${required.join("`, `")}\`; ` +
              "a count in a missing category falls through to `other` and reads as the wrong grammatical form",
          });
        }

        for (const category of required) {
          const count = representativeFor(locale, category, type);

          if (count === undefined) {
            violations.push({
              locale,
              key,
              problem: `no test number produces the \`${category}\` category`,
              because:
                "the branch cannot be exercised, so this gate cannot confirm it formats — widen the candidates in `representativeFor`",
            });
            continue;
          }

          const failure = formatFailure(locale, key, message, count);
          if (failure) {
            violations.push({
              locale,
              key,
              problem: `fails to format at count ${count} (\`${category}\`): ${failure}`,
              because:
                "next-intl formats with this exact translator, so the same message would throw or render empty in a page",
            });
          }
        }
      }
    }
  }

  return violations;
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map(
      ({ locale, key, problem }, index) =>
        `  ${index + 1}. [${locale}] ${key} — ${problem}`,
    )
    .join("\n");
}

/** Reads one catalogue, returning `undefined` if it is absent or unparseable. */
export function readCatalogue(
  messagesDir: string,
  locale: Locale,
): Catalogue | undefined {
  try {
    const raw = readFileSync(path.join(messagesDir, `${locale}.json`), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Catalogue)
      : undefined;
  } catch {
    return undefined;
  }
}

function main(argv: readonly string[]): number {
  const messagesDir = argv[0] ?? "messages";
  const catalogues: Partial<Record<Locale, Catalogue>> = {};

  for (const locale of LOCALES) {
    // Assigned only when it parsed: an absent key is how `checkCatalogues`
    // spells "no catalogue for this locale", and writing `undefined` into the
    // key would be a different thing that happens to behave the same.
    const catalogue = readCatalogue(messagesDir, locale);
    if (catalogue) catalogues[locale] = catalogue;
  }

  const violations = checkCatalogues(catalogues);

  if (violations.length > 0) {
    console.error(
      `Message catalogues are not consistent — ${violations.length} problem(s):\n\n` +
        `${formatViolations(violations)}\n\n` +
        violations
          .map(
            ({ locale, key, because }, index) =>
              `  ${index + 1}. [${locale}] ${key}: ${because}`,
          )
          .join("\n") +
        "\n",
    );
    return 1;
  }

  const keyCount = flattenKeys(catalogues[DEFAULT_LOCALE] ?? {}).length;
  console.log(
    `i18n catalogues OK — ${LOCALES.length} locale(s), ${keyCount} key(s) each, ` +
      `plural branches checked against CLDR (${LOCALES.map(
        (locale) => `${locale}: ${requiredCategories(locale).length}`,
      ).join(", ")} cardinal categories).`,
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
