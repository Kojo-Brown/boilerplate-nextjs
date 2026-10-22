import { DEFAULT_LOCALE, textDirection } from "@/i18n/locales";
import { SKIP_LINK_HREF, MAIN_CONTENT_ID } from "@/lib/a11y/route-focus";

/**
 * The 404 for a URL that matches no route at all, including no `[locale]`.
 *
 * ## Why this file exists
 *
 * Before the `[locale]` restructure, `src/app/not-found.tsx` was the document
 * Next served for every unmatched path, and its only purpose was to carry the
 * skip link and the `<main>` landmark — deleting it restores Next's built-in
 * 404, which renders perfectly and has neither.
 * `scripts/assert-focus-management.ts` has `/_not-found` in `REQUIRED_DOCUMENTS`
 * for exactly that reason.
 *
 * Moving the tree under `[locale]` moved that file to
 * `src/app/[locale]/not-found.tsx`, where it is the boundary for paths *inside*
 * the segment — which is most unmatched paths, because a single unknown segment
 * (`/nope`) is read as a locale, fails `isLocale` in the layout, and renders
 * that boundary with its landmark intact. What it is not is the boundary for a
 * path the segment cannot match at all: `/a/b/c` reaches no route, and the
 * document Next writes for it is `_not-found.html` above the whole layout
 * hierarchy. That document went back to being Next's own, and the gate said so:
 *
 *     /_not-found  [R4] has no element with id="main-content"
 *     /_not-found  [R5] has no skip link
 *
 * `global-not-found.tsx` is Next 16's answer to this. It renders its own
 * document, outside every layout, the way `global-error.tsx` does — which is
 * what makes it the only place that hole can be filled now.
 *
 * ## `lang` is the default locale, and that is a real limitation
 *
 * There is no locale to read. The URL matched no `[locale]` segment, so there
 * is no segment value, and this component renders above the provider that would
 * know one. `DEFAULT_LOCALE` is the honest answer rather than a guess at the
 * `Accept-Language` header, which is not available to a prerendered document;
 * the alternative is no `lang` at all, which is the WCAG 3.1.1 failure this
 * file is here to avoid. A visitor whose URL named a locale is not in this
 * document — they are in `src/app/[locale]/not-found.tsx`, in their own
 * language.
 *
 * ## Why the styles are inline
 *
 * The same reason `global-error.tsx` gives: this renders outside the root
 * layout, so the stylesheet that layout links is not in the document and the
 * theme provider that writes `.light`/`.dark` onto `<html>` has not run. The
 * tokens are the ones from `globals.css`, under `prefers-color-scheme`.
 *
 * The one copy is deliberate. `scripts/assert-logical-properties.ts` reads
 * Tailwind class names, and there are none here to read — but the layout is a
 * centred panel with no directional margins at all, so there is nothing for a
 * logical property to fix.
 */

const STYLES = `
  .global-not-found {
    --bg: oklch(100% 0 0);
    --fg: oklch(9% 0 0);
    --muted-fg: oklch(45% 0 0);
    --link-fg: oklch(9% 0 0);
    background-color: var(--bg);
    color: var(--fg);
    font-family: ui-sans-serif, system-ui, sans-serif;
    display: flex;
    min-height: 100vh;
    align-items: center;
    justify-content: center;
    margin: 0;
    padding: 1.5rem;
  }
  @media (prefers-color-scheme: dark) {
    .global-not-found {
      --bg: oklch(9% 0 0);
      --fg: oklch(98% 0 0);
      --muted-fg: oklch(65% 0 0);
      --link-fg: oklch(98% 0 0);
    }
  }
  .global-not-found__skip {
    position: absolute;
    inset-inline-start: 0.75rem;
    inset-block-start: -3rem;
    z-index: 50;
    border-radius: 0.375rem;
    background-color: var(--fg);
    color: var(--bg);
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    font-weight: 500;
    text-decoration: none;
    transition: inset-block-start 150ms;
  }
  .global-not-found__skip:focus {
    inset-block-start: 0.75rem;
  }
  .global-not-found__panel { max-width: 32rem; }
  /* The ring MainContent gets from Tailwind, which this document cannot
     import. Negative offset for the reason that component records: the panel
     fills the column, so a positive offset draws the ring off the viewport. */
  .global-not-found__panel:focus-visible {
    outline: 2px solid var(--fg);
    outline-offset: -2px;
  }
  .global-not-found__title { font-size: 1.5rem; font-weight: 600; margin: 0; }
  .global-not-found__message { margin: 0.75rem 0 0; color: var(--muted-fg); }
  .global-not-found__home {
    display: inline-block;
    margin-block-start: 1.5rem;
    min-height: 2.75rem;
    padding: 0.625rem 0;
    color: var(--link-fg);
    font-weight: 500;
  }
  .global-not-found__home:focus-visible {
    outline: 2px solid var(--fg);
    outline-offset: 2px;
  }
`;

export const metadata = {
  title: "Page not found",
};

export default function GlobalNotFound() {
  return (
    <html lang={DEFAULT_LOCALE} dir={textDirection(DEFAULT_LOCALE)}>
      <head>
        <style>{STYLES}</style>
      </head>
      <body className="global-not-found">
        {/*
          The skip link is first in the body and the landmark is what it points
          at — the two halves R4 and R5 of
          `scripts/assert-focus-management.ts` check for. A plain anchor rather
          than `<SkipLink>`, and `<a>` rather than `@/i18n/navigation`'s
          `Link`: both of those are Client Components that read context this
          document renders above.
        */}
        <a href={SKIP_LINK_HREF} className="global-not-found__skip">
          Skip to main content
        </a>
        {/*
          `tabIndex={-1}` is not decoration: without it the skip link scrolls
          the landmark into view and leaves focus on `<body>`, so the next Tab
          goes back to the top of the document. That is the most common way a
          skip link ships broken and it is invisible to a mouse — rule R4 of
          `scripts/assert-focus-management.ts` is what catches it, and it
          caught this file.
        */}
        <main
          id={MAIN_CONTENT_ID}
          tabIndex={-1}
          className="global-not-found__panel"
        >
          <h1 className="global-not-found__title">Page not found</h1>
          <p className="global-not-found__message">
            That URL does not match anything in this application.
          </p>
          <a href="/" className="global-not-found__home">
            Go to the home page
          </a>
        </main>
      </body>
    </html>
  );
}
