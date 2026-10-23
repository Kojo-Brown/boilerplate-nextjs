/**
 * Splitting the locale off a pathname, and putting it back on.
 *
 * ## Why this exists at all
 *
 * `PROTECTED_PREFIXES` and `ADMIN_PREFIXES` in `@/auth.config` are matched with
 * `pathname.startsWith(prefix)`, and `/ar/admin` starts with none of them. With
 * the `[locale]` segment in place and nothing else changed, the proxy's session
 * gate would have stopped gating every route in every locale but the default:
 * `/ar/dashboard` and `/ar/admin` would have been handed to the renderer for an
 * anonymous request.
 *
 * This repository is built so that is a defence-in-depth regression rather than
 * an open door — every gated route also reads the session next to its data,
 * `/admin` included, which is why the role check sits inside
 * `<AdminSessionFields>` rather than in the page. What would have been lost is
 * the outer layer: the refusal moves from *before the response* to *inside a
 * streamed boundary*, so an anonymous request starts getting a prerendered
 * shell for a route that used to redirect. That is the cheap early gate the
 * prefix lists exist to provide, and it would have been gone at every prefixed
 * locale while every test in the suite still passed.
 *
 * So the gate strips the locale first, and that is what these two functions
 * are for.
 *
 * ## Why it is here and not in `@/i18n/routing`
 *
 * `@/auth.config` is the deliberately import-light half of the Auth.js split —
 * it is loaded by the proxy on every request — and `next-intl/routing` pulls in
 * a locale matcher and an `Accept-Language` negotiator. `@/i18n/locales`
 * imports nothing, so this module costs the registry and two string operations.
 * `next-intl`'s own path helpers are the right tool inside the application,
 * where the request config has already resolved a locale; they are not
 * available to a module that has to answer the question before any of that has
 * run.
 */
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/locales";

export interface SplitPath {
  /** The locale the path was prefixed with, or `null` if it carried none. */
  locale: Locale | null;
  /**
   * The path with the prefix removed, always starting with `/`.
   *
   * `/ar` and `/ar/` both give `"/"` rather than `""`, because `""` starts with
   * no prefix in any list and `startsWith` against it is false for everything —
   * a locale root that answered "not protected" to every question.
   */
  pathname: string;
}

/**
 * Splits a leading locale segment off `pathname`.
 *
 * The first segment is compared whole. A prefix test would be wrong in both
 * directions: `/arabic` begins with `ar` and is not an `ar` path, and
 * `//evil.example` has an empty first segment that must not be mistaken for
 * one. `isLocale` is the registry's own narrowing, so a locale added to
 * `LOCALES` is recognised here with no second list to update.
 *
 * `en` is stripped too, even though `localePrefix: "as-needed"` means
 * `/en/dashboard` is not a URL this application serves — `next-intl`'s
 * middleware redirects it to `/dashboard`. The gate runs *before* that
 * redirect, and a path the gate declines to recognise is a path it declines to
 * protect, so recognising it costs nothing and not recognising it would make
 * the ordering of two middlewares a security property.
 */
export function splitLocalePath(pathname: string): SplitPath {
  const slash = pathname.indexOf("/", 1);
  const first = pathname.slice(1, slash === -1 ? undefined : slash);

  if (!isLocale(first)) return { locale: null, pathname };

  const rest = slash === -1 ? "" : pathname.slice(slash);
  return { locale: first, pathname: rest === "" ? "/" : rest };
}

/**
 * Puts `locale`'s prefix back on a public path.
 *
 * The inverse of `splitLocalePath` for the paths this application mints, and
 * `localePrefix: "as-needed"` is the whole of the asymmetry: the default locale
 * takes no prefix, so prefixing it would produce `/en/login`, which
 * `next-intl`'s middleware answers with a redirect to `/login`. A redirect to a
 * redirect, on the one path an anonymous visitor is guaranteed to be sent to.
 */
export function localisePath(locale: Locale, pathname: string): string {
  if (locale === DEFAULT_LOCALE) return pathname;
  return pathname === "/" ? `/${locale}` : `/${locale}${pathname}`;
}

/**
 * The path Next actually renders for `pathname` at `locale`.
 *
 * Not the same thing as `localisePath`, and the difference is the whole of
 * `localePrefix: "as-needed"`:
 *
 * - `localisePath("en", "/pricing")` is `"/pricing"` — the *public* URL, what
 *   belongs in an `href`, a `Location` header or the address bar.
 * - `internalPath("en", "/pricing")` is `"/en/pricing"` — the *segment* path,
 *   what the filesystem under `src/app/[locale]` actually answers and what a
 *   rewrite has to target.
 *
 * Those two were the same string for every locale until the `[locale]` segment
 * existed, which is why a single helper would read as sufficient and would be
 * wrong in opposite ways at each call site: a rewrite to the public path 404s
 * for the default locale, and a redirect to the internal path bounces through
 * `next-intl`'s canonical-URL redirect on the way back out.
 *
 * It is also what `decideCsp` has to be told: the policy carries the digests of
 * the document that will be rendered, the prerender manifest keys those
 * documents by their segment paths, and `request.nextUrl.pathname` is the
 * public one.
 */
export function internalPath(locale: Locale, pathname: string): string {
  return pathname === "/" ? `/${locale}` : `/${locale}${pathname}`;
}
