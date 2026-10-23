import { MAIN_CONTENT_ID, SKIP_LINK_HREF } from "@/lib/a11y/route-focus";

export interface SkipLinkProps {
  /**
   * The label, which the caller supplies from the catalogue.
   *
   * `src/app/[locale]/layout.tsx` passes `common.skipToContent`. The default is
   * kept for the one caller that cannot: this element has to be the first child
   * of `<body>`, which is above `<IntlProvider>`, so a `useTranslations` here
   * would have no context to read — and reading the catalogue on the server
   * would make this an async component in the position where
   * `cacheComponents` refuses one. See `@/components/providers/intl-provider`.
   */
  children?: React.ReactNode;
}

/**
 * "Skip to main content" — the first focusable thing in the document.
 *
 * A Server Component and a plain `<a>`, both on purpose.
 *
 * Plain `<a>` and not `<Link>`: the href is a same-document fragment, which
 * the browser resolves itself. Routing it through the router would turn the
 * one control a keyboard user reaches before anything else has loaded into
 * something that needs JavaScript to work, and would push a history entry for
 * a move within the current page. This way it works in a document that has
 * not hydrated, which is the window in which someone tabbing immediately
 * after a page load is actually using it.
 *
 * Visually hidden until focused, rather than `sr-only` permanently. A skip
 * link that never becomes visible fails 2.4.7 for the sighted keyboard user —
 * the person it is arguably most useful to, who otherwise sees focus vanish
 * for one Tab and reappear in the content with no explanation. The off-screen
 * position rather than `display: none` or `visibility: hidden` is what keeps
 * it focusable at all: both of those take an element out of the tab order
 * entirely.
 *
 * It renders on every route because it is in the root layout, and it must be
 * the first element in `<body>` — a skip link that comes after the navigation
 * it exists to skip is decoration. `scripts/assert-focus-management.ts`
 * asserts that position in the prerendered documents rather than trusting the
 * source, because the root layout's children are composed from several
 * providers and a wrapper inserted above it would move it without touching
 * this file.
 */
export function SkipLink({ children = "Skip to main content" }: SkipLinkProps) {
  return (
    <a
      href={SKIP_LINK_HREF}
      data-skip-link-target={MAIN_CONTENT_ID}
      className="sr-only rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] focus:not-sr-only focus:absolute focus:top-2 focus:start-2 focus:z-50 focus:outline-2 focus:outline-offset-2 focus:outline-[var(--foreground)]"
    >
      {children}
    </a>
  );
}
