/**
 * The locales this application ships, and which way each one reads.
 *
 * This module is deliberately free of any `next-intl` import. It is the one
 * piece of i18n configuration that both the server and the client need, that
 * the build-time catalogue gate needs, and that `<html lang>`/`<html dir>` need
 * — and `next-intl/routing` pulls in the locale matcher and the negotiator,
 * neither of which belongs in a client bundle that only wants to know which way
 * the page reads. Keeping the registry here means the routing config in
 * `src/i18n/routing.ts` (added with the `[locale]` segment) imports *this*
 * rather than the other way round, so there is exactly one list of locales and
 * it is the one with no dependencies.
 *
 * ## Why these two locales
 *
 * `en` is the default because every string in the repository is already written
 * in it. `ar` is the second one, and it was chosen over the usual `es`/`fr`
 * placeholder for two reasons that are the whole point of the exercise:
 *
 * 1. It reads right-to-left, so it is the only kind of locale that can prove
 *    the layout is direction-agnostic. A second left-to-right locale exercises
 *    the message lookup and nothing else — every physical `ml-`/`left-`
 *    utility in the tree would still look correct in it.
 * 2. Its CLDR plural rules have all six categories (`zero`, `one`, `two`,
 *    `few`, `many`, `other`) against English's two. A catalogue translated by
 *    someone working from the English file will have two, render the `other`
 *    branch for 2, 3 and 11, and be grammatically wrong in a way no type and no
 *    rendering test would notice. `scripts/assert-i18n-catalogues.ts` fails the
 *    build on exactly that, and `ar` is what gives it something to fail on.
 *
 * A third locale is a one-line addition here plus its catalogue; the gate will
 * then require that catalogue to be complete before the build goes green.
 */

/**
 * Every locale with a catalogue, in the order they should be offered.
 *
 * `as const` and not `string[]`: `Locale` is derived from this array, so adding
 * a locale here is what makes the catalogue gate demand a `messages/<tag>.json`
 * and what makes `TEXT_DIRECTIONS` below fail to compile until its direction is
 * declared. A widened type would make both of those silently optional.
 */
export const LOCALES = ["en", "ar"] as const;

/** A locale this application has a catalogue for. */
export type Locale = (typeof LOCALES)[number];

/**
 * The locale served when the request names none, and the source of truth for
 * every string in the repository.
 *
 * It is also the catalogue the gate compares the others against: a key that
 * exists in `ar` and not in `en` is a key nothing renders.
 */
export const DEFAULT_LOCALE = "en" satisfies Locale;

/** The value of the `dir` attribute, as HTML spells it. */
export type TextDirection = "ltr" | "rtl";

/**
 * Which way each locale reads.
 *
 * `satisfies Record<Locale, TextDirection>` rather than an annotation: the
 * `satisfies` keeps the literal value types (so `textDirection("ar")` is known
 * to be `"rtl"`, not widened to `TextDirection`) while still failing to compile
 * if a locale is added to `LOCALES` and not given a direction here. An
 * annotation would widen; an index signature would let a missing locale through
 * and return `undefined` into `dir`, which browsers resolve as `ltr` — the one
 * wrong answer that looks like it worked.
 */
const TEXT_DIRECTIONS = {
  en: "ltr",
  ar: "rtl",
} as const satisfies Record<Locale, TextDirection>;

/**
 * Narrows an untrusted string — a route param, a cookie, an `Accept-Language`
 * fragment — to a locale this application actually has messages for.
 *
 * `[locale]` is a dynamic segment, so the value arriving in it is whatever was
 * in the URL. Looking a catalogue up by it unchecked is how `/xx/dashboard`
 * renders a page with every string missing.
 */
export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (LOCALES as readonly string[]).includes(value)
  );
}

/** Which way `locale` reads. */
export function textDirection(locale: Locale): TextDirection {
  return TEXT_DIRECTIONS[locale];
}
