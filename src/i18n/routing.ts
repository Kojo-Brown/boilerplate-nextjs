/**
 * How locales appear in the URL.
 *
 * This is the `next-intl` half of the registry: it imports `@/i18n/locales`
 * rather than re-declaring the list, so there stays exactly one array of
 * locales and it is the one with no dependencies. Everything that only needs to
 * know *which* locales exist, or which way one reads, keeps importing that
 * module and keeps paying nothing for it — the locale matcher and the
 * `Accept-Language` negotiator `next-intl/routing` pulls in are needed by the
 * proxy and by the navigation wrappers, and by nothing else.
 *
 * ## Why `as-needed` and not `always`
 *
 * `as-needed` serves the default locale at unprefixed paths: `/dashboard` is
 * `en`, `/ar/dashboard` is `ar`. `always` would have redirected `/dashboard` to
 * `/en/dashboard`.
 *
 * The product argument is the usual one — the majority locale keeps the shorter
 * URL, and every link that has ever been shared still resolves. The argument
 * that decided it here is narrower and specific to this repository: the
 * canonical path of a routed experiment is load-bearing in three places that
 * are not in `src/app` at all. `next.config.ts` pins `Cache-Control` on
 * `/pricing`, `src/proxy.ts` rewrites it to `/pricing/v/<variant>`, and
 * `scripts/assert-experiment-wiring.ts` holds the registry against both. Under
 * `always` the canonical path of every experiment becomes a set of paths, one
 * per locale, and the `headers()` block — which matches the *incoming* path,
 * before any rewrite — has to enumerate them. Under `as-needed` the existing
 * entry keeps covering `en` and the locale-prefixed paths are additive, which
 * is the difference between extending that block and rewriting the three
 * things that agree about it. The prefixed paths still need covering; see the
 * `headers()` block for the pattern that does it.
 *
 * `localeDetection` is left on. A first request with `Accept-Language: ar` and
 * no cookie is redirected to `/ar`, which is what the header is for; every
 * later request carries `NEXT_LOCALE` and is answered from it. The redirect is
 * why `/` is not in the rate limiter's quiet list — see
 * `@/lib/rate-limit/enforce`.
 */
import { defineRouting } from "next-intl/routing";
import { DEFAULT_LOCALE, LOCALES } from "@/i18n/locales";

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: "as-needed",
});
