/**
 * Locale-aware `Link`, `redirect`, `usePathname`, `useRouter` and `getPathname`.
 *
 * Everything in `src/app` and `src/components` imports these instead of the
 * `next/link` and `next/navigation` originals, and the reason is not
 * convenience. A plain `<Link href="/posts/1">` rendered on an `ar` page points
 * at the `en` document: the href is an absolute path, it carries no locale, and
 * `localePrefix: "as-needed"` resolves an unprefixed path to the default
 * locale. The visitor's next click leaves the language they chose, which is a
 * defect no type can see and no single-locale test can reach. These wrappers
 * read the active locale from the request (or, in a Client Component, from
 * `NextIntlClientProvider`) and prefix the href with it — or don't, for `en`,
 * which is what `as-needed` means.
 *
 * ## What this costs, and why it is accepted
 *
 * `typedRoutes: true` is still on in `next.config.ts`, and `href` on these
 * components is `string`, not a generated `Route`. That is a real loss of the
 * check this repository deliberately paid for, and it is not a shortcut — it is
 * forced, because under `as-needed` Next's generated route type and the URLs
 * this application actually serves disagree:
 *
 * - The filesystem is `src/app/[locale]/posts/[id]`, so `next typegen` emits
 *   `/[locale]/posts/[id]` and considers `/posts/1` to be no route at all.
 * - The URL `en` is actually served at *is* `/posts/1`. `/en/posts/1` is
 *   redirected away by `next-intl`'s middleware, because the point of
 *   `as-needed` is that the default locale has exactly one canonical URL.
 *
 * So the generated type describes the segment tree and these wrappers take the
 * public path, and nothing can be both. Declaring `pathnames` in
 * `@/i18n/routing` would restore a typed `href` — at the cost of a second,
 * hand-maintained inventory of every route in the application, which is the
 * drift this repository spends gates preventing rather than introducing.
 *
 * `scripts/assert-locale-hrefs.ts` is what replaces the lost check: it reads
 * every href literal in the tree and resolves it against the route tree on
 * disk, so a link to a route that does not exist still fails the build. It
 * covers what `typedRoutes` covered for these call sites — a wrong path — and
 * it reaches one thing `typedRoutes` never did, which is whether the href was
 * written against the public paths or against the segment tree.
 */
import { createNavigation } from "next-intl/navigation";
import { routing } from "@/i18n/routing";

export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
