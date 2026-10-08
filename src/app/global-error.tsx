"use client";

/**
 * The boundary for an error thrown by the root layout itself.
 *
 * Next replaces the whole document when this renders — including the layout
 * that links the application's stylesheet and mounts the theme provider — so
 * everything this page needs has to be in this file. That is also why it does
 * not import `@/styles/globals.css`: the root layout is what just failed, and a
 * last-resort page whose legibility depends on the build graph that broke is
 * not a last resort.
 *
 * It exists at all because of the accessibility gate, which found that the
 * document a visitor reaches when everything else has gone wrong was
 * `<html id="__next_error__">` with no `lang` — a WCAG 3.1.1 failure in the
 * least recoverable place in the application. Defining this component fixes the
 * runtime boundary. It does *not* change `_global-error.html`: that document is
 * Next's own static 500 fallback, emitted identically whether or not this file
 * exists, which is why `ALLOWED_VIOLATIONS` in
 * `scripts/assert-accessibility.ts` has one entry pinned to Next's markup.
 *
 * The colours are the same tokens as `globals.css`, under
 * `prefers-color-scheme` rather than the `.dark` class, because the provider
 * that writes that class is in the layout this page replaces.
 */

const STYLES = `
  .global-error {
    --bg: oklch(100% 0 0);
    --fg: oklch(9% 0 0);
    --muted-fg: oklch(45% 0 0);
    --btn-bg: oklch(9% 0 0);
    --btn-fg: oklch(100% 0 0);
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
    .global-error {
      --bg: oklch(9% 0 0);
      --fg: oklch(98% 0 0);
      --muted-fg: oklch(65% 0 0);
      --btn-bg: oklch(98% 0 0);
      --btn-fg: oklch(9% 0 0);
    }
  }
  .global-error__panel { max-width: 32rem; }
  .global-error__title { font-size: 1.5rem; font-weight: 600; margin: 0; }
  .global-error__message { margin: 0.75rem 0 0; color: var(--muted-fg); }
  .global-error__digest {
    margin: 0.75rem 0 0;
    font-family: ui-monospace, monospace;
    font-size: 0.875rem;
    color: var(--muted-fg);
  }
  .global-error__retry {
    margin-top: 1.5rem;
    border: 0;
    border-radius: 0.5rem;
    background-color: var(--btn-bg);
    color: var(--btn-fg);
    font: inherit;
    font-weight: 500;
    padding: 0.625rem 1.25rem;
    min-height: 2.75rem;
    cursor: pointer;
  }
  .global-error__retry:focus-visible {
    outline: 2px solid var(--fg);
    outline-offset: 2px;
  }
`;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <head>
        <title>Something went wrong</title>
        <style>{STYLES}</style>
      </head>
      <body className="global-error">
        <main className="global-error__panel">
          <h1 className="global-error__title">Something went wrong</h1>
          <p className="global-error__message">
            The page could not be rendered. Trying again is usually enough; if
            it is not, the error below is what to report.
          </p>
          {error.digest ? (
            <p className="global-error__digest">
              Error reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            className="global-error__retry"
            onClick={() => reset()}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
