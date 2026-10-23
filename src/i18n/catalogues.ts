/**
 * The message catalogues, as a value rather than as a thing to go and fetch.
 *
 * ## Why these are static imports
 *
 * `await import(`../../messages/${locale}.json`)` is what the `next-intl`
 * documentation shows, and it is the wrong shape here twice over. A template
 * literal in an `import()` makes the whole directory a dynamic dependency: the
 * bundler cannot tell which files are reachable, so it emits a chunk per
 * candidate and resolves at runtime, and a missing catalogue becomes a
 * rejection inside a render rather than a build failure. And the read is
 * *uncached and asynchronous*, which under `cacheComponents` is the one kind of
 * read a prerender cannot contain: `<NextIntlClientProvider>` with no
 * `messages` prop awaits `getMessages()` on the server, and that await ended
 * the build —
 *
 *     Route "/[locale]/forbidden": Uncached data was accessed outside of
 *     <Suspense>. This delays the entire page from rendering.
 *
 * — on the first route that had nothing else to stream. Wrapping the providers
 * in a `<Suspense>` would have "fixed" it by putting every page's entire body
 * behind a boundary, which is the regression `scripts/assert-route-shape.ts`
 * and `scripts/assert-streaming-boundaries.ts` both exist to catch.
 *
 * `scripts/assert-i18n-catalogues.ts` already refuses to let a locale exist
 * without a complete catalogue, so the set is known at build time. Naming each
 * file makes `tsc` and the bundler agree with the gate, costs one await
 * nothing, and makes adding a locale fail to compile here until its catalogue
 * exists.
 *
 * `satisfies Record<Locale, AbstractIntlMessages>` is what performs that check:
 * adding a locale to `LOCALES` and not to this map is a type error, in the same
 * way that not giving it a direction is a type error in the registry.
 */
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";
import type { Locale } from "@/i18n/locales";
import type { AbstractIntlMessages } from "next-intl";

export const CATALOGUES = { en, ar } satisfies Record<
  Locale,
  AbstractIntlMessages
>;
