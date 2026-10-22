/**
 * The per-request `next-intl` configuration: which locale, and which messages.
 *
 * `next.config.ts` points the `next-intl` plugin at this file, and from then on
 * every `getTranslations()` in a Server Component or an action reads what this
 * returns. Client Components are given the catalogue by
 * `<NextIntlClientProvider>` in `src/app/[locale]/layout.tsx`, which passes it
 * explicitly — see `@/i18n/catalogues` for why that is not left to this file.
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
 * `src/app/global-error.tsx` and Next's own `/_not-found` document. Those get
 * the default locale rather than a thrown error, because a 500 boundary that
 * crashes while deciding which language to apologise in is worse than one that
 * apologises in English.
 *
 * The layout's own `notFound()` is the stricter half of the same question and
 * is not duplicated here: this file cannot distinguish "outside the segment"
 * from "an unknown first segment", and only one of those should 404.
 */
import { getRequestConfig } from "next-intl/server";
import { CATALOGUES } from "@/i18n/catalogues";
import { DEFAULT_LOCALE, isLocale } from "@/i18n/locales";

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;

  return { locale, messages: CATALOGUES[locale] };
});
