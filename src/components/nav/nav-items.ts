/**
 * The navigation destinations, and the catalogue keys that label them.
 */

export interface NavItem {
  /**
   * The item's key under `nav` in the message catalogues.
   *
   * A label and not a key was what this held until the catalogues were wired
   * up, which meant `"Dashboard"` appeared in the markup of every locale. The
   * union is not written out by hand — `useTranslations("nav")` is typed
   * against the `en` catalogue through the `AppConfig` augmentation in
   * `@/i18n/messages`, so a key that is not in `messages/en.json` fails to
   * compile at the call site in `nav-links.tsx`.
   */
  labelKey: "dashboard" | "posts" | "upload" | "images" | "admin" | "security";
  /**
   * The destination, as a *public* path with no locale prefix.
   *
   * `string` and not Next's generated `Route`, and the reason is the
   * `localePrefix: "as-needed"` decision rather than laziness: the filesystem
   * is `src/app/[locale]/dashboard`, so `next typegen` emits
   * `/[locale]/dashboard` and does not consider `/dashboard` a route — while
   * `/dashboard` is exactly the URL `en` is served at. `@/i18n/navigation`'s
   * `Link` takes the public path and adds the prefix per locale, and
   * `scripts/assert-locale-hrefs.ts` is what checks these resolve to real
   * routes. See the header of `@/i18n/navigation`.
   */
  href: string;
}

export const NAV_ITEMS: NavItem[] = [
  { labelKey: "dashboard", href: "/dashboard" },
  { labelKey: "posts", href: "/posts" },
  { labelKey: "upload", href: "/upload" },
  { labelKey: "images", href: "/images" },
  { labelKey: "admin", href: "/admin" },
  { labelKey: "security", href: "/settings/security" },
];
