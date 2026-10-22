/**
 * The per-request `next-intl` configuration: which locale, and which messages.
 *
 * `next.config.ts` points the `next-intl` plugin at this file, and from then on
 * every `getTranslations()` in a Server Component or an action reads what this
 * returns. Client Components are given the catalogue by
 * `<NextIntlClientProvider>` in `src/app/[locale]/layout.tsx`, which passes it
 * explicitly — see `@/i18n/catalogues` for why that is not left to this file.
 *
 * ## Why `next/root-params` and not `requestLocale`
 *
 * `requestLocale` is what `next-intl` documents, and it is deprecated in favour
 * of this. It is also wrong here in a way that is invisible until you look at
 * the markup: it is request-scoped, so during a *prerender* it resolves to
 * `undefined` and the locale falls back to `DEFAULT_LOCALE`. Every
 * server-rendered `<Link>` outside the root layout then emits an unprefixed
 * href — `/ar` was prerendered with `href="/blog"` on every link, so one click
 * took an Arabic visitor to the English document. `e2e/locale.spec.ts` found
 * that; no unit test could, because the defect is in what the build wrote.
 *
 * `setRequestLocale` is next-intl's own fix and it has to be called in every
 * layout *and every page*, because the cache it writes is scoped to one render
 * entry point. See the note on `experimental.rootParams` in `next.config.ts`
 * for why twenty-two `await params` calls was the wrong trade. Root params are
 * provided per prerendered variant, so the locale resolves once, here, for
 * every render in the tree.
 *
 * ## The value still has to be narrowed
 *
 * `[locale]` is a dynamic segment, and a dynamic segment at the root of the
 * tree is effectively a catch-all: a request for `/robots.txt` that matches no
 * static file arrives here with the param set to `"robots.txt"`. Looking a
 * catalogue up by that unchecked is how a page renders with every string
 * missing — `next-intl` falls back to printing the key path, so the visitor
 * gets `nav.dashboard` where a link should be and the build stays green.
 * `isLocale` from the registry is the one narrowing, and `DEFAULT_LOCALE` is
 * what an unrecognised value becomes.
 *
 * The value can also legitimately be `undefined`: anything rendering outside
 * the `[locale]` segment has no root param to read, which in this tree is
 * `src/app/global-error.tsx`, `src/app/global-not-found.tsx` and Next's own
 * `/_not-found` document. Those get the default locale rather than a thrown
 * error, because a 500 boundary that crashes while deciding which language to
 * apologise in is worse than one that apologises in English.
 *
 * The layout's own `notFound()` is the stricter half of the same question and
 * is not duplicated here: this file cannot distinguish "outside the segment"
 * from "an unknown first segment", and only one of those should 404.
 */
import { locale as localeRootParam } from "next/root-params";
import { getRequestConfig } from "next-intl/server";
import { CATALOGUES } from "@/i18n/catalogues";
import { DEFAULT_LOCALE, isLocale } from "@/i18n/locales";

export default getRequestConfig(async () => {
  const requested = await localeRootParam();
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;

  return { locale, messages: CATALOGUES[locale] };
});
