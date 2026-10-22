/**
 * The per-request `next-intl` configuration: which locale, and which messages.
 *
 * `next.config.ts` points the `next-intl` plugin at this file, and from then on
 * every `useTranslations()` in a Server Component and every `getTranslations()`
 * in an action reads what this returns.
 *
 * ## `requestLocale` has to be narrowed, not trusted
 *
 * `[locale]` is a dynamic segment, and a dynamic segment at the root of the
 * tree is effectively a catch-all: a request for `/robots.txt` that matches no
 * static file arrives here with `requestLocale` resolving to `"robots.txt"`.
 * Looking a catalogue up by that unchecked is how a page renders with every
 * string missing — `next-intl` falls back to printing the key path, so the
 * visitor gets `nav.dashboard` where a link should be and the build stays
 * green. `isLocale` from the registry is the one narrowing, and
 * `DEFAULT_LOCALE` is what an unrecognised value becomes.
 *
 * The value can also legitimately be `undefined`: anything rendering outside
 * the `[locale]` segment has no segment to read, which in this tree is
 * `app/global-error.tsx` and Next's own `/_not-found` document. Those get the
 * default locale rather than a thrown error, because a 500 boundary that
 * crashes while deciding which language to apologise in is worse than one that
 * apologises in English.
 *
 * ## Why the catalogue is a static import
 *
 * `await import(`../../messages/${locale}.json`)` is what the `next-intl`
 * documentation shows, and it is the wrong shape for this repository. A
 * template literal in an `import()` makes the whole directory a dynamic
 * dependency: the bundler cannot tell which files are reachable, so it emits a
 * chunk per candidate and resolves at runtime, and a missing catalogue becomes
 * a runtime rejection inside a render rather than a build failure.
 * `scripts/assert-i18n-catalogues.ts` already refuses to let a locale exist
 * without a complete catalogue, so the set is known at build time; naming each
 * one makes `tsc` and the bundler agree with the gate, and makes adding a
 * locale fail to compile here until its catalogue exists.
 *
 * `satisfies Record<Locale, AbstractIntlMessages>` is what performs that check:
 * adding a locale to `LOCALES` and not to this map is a type error, in the same
 * way that not giving it a direction is a type error in the registry.
 */
import { getRequestConfig } from "next-intl/server";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/locales";
import type { AbstractIntlMessages } from "next-intl";

const CATALOGUES = { en, ar } satisfies Record<Locale, AbstractIntlMessages>;

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;

  return { locale, messages: CATALOGUES[locale] };
});
