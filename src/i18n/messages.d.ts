/**
 * Makes message keys a compile-time check rather than a rendering surprise.
 *
 * `next-intl` resolves `t("nav.dashboard")` at runtime and, when the key is not
 * in the catalogue, renders the key path itself. So a typo in a key, or a
 * reference to a message that was renamed, produces a page showing
 * `nav.dashbaord` where a link label should be — no exception, no failing test,
 * no build error. `scripts/assert-i18n-catalogues.ts` cannot see it either: it
 * compares the catalogues against each other, and a key no catalogue has is
 * consistent in all of them.
 *
 * Augmenting `AppConfig` is what closes that. `Messages` is the *type* of the
 * `en` catalogue — `en` and not `ar`, because `DEFAULT_LOCALE` is the reference
 * every other catalogue is held against — so `useTranslations("nav")` knows
 * which keys exist and `t("dashbaord")` stops compiling. `Locale` is bound to
 * the registry's union for the same reason, which is what makes
 * `useLocale()` return `"en" | "ar"` rather than `string` and lets
 * `textDirection()` accept it without a narrowing step at each call site.
 *
 * This is a `.d.ts` because it declares and emits nothing. It is under
 * `src/i18n/` rather than at the project root so that the one directory holds
 * every i18n decision; `tsconfig.json` includes `**\/*.ts`, which covers it.
 */
import type { Locale } from "@/i18n/locales";
import type messages from "../../messages/en.json";

declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof messages;
  }
}
