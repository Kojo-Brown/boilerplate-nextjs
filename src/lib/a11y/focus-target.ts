/**
 * Which elements can actually take the focus, and which of them are inside a
 * container.
 *
 * `canTakeFocus` was private to `./focus-memory`, where it guards a remembered
 * element on a Back press. It moved here when the modal focus hook needed the
 * same two conditions for a different reason, and the conditions are the whole
 * value of this module: both of them are cases where `focus()` neither throws
 * nor returns anything, so getting one wrong produces code that looks like it
 * works and leaves the focus on `<body>`.
 */

/**
 * Whether an element can actually take the focus.
 *
 * Two conditions, and the second one cost a browser to find.
 *
 * `isConnected` is the obvious one: anything at all holding a node — a React
 * fiber, an event handler closure, a `WeakRef` in a focus memory — keeps it
 * alive after it leaves the document. Focusing it moves focus to nowhere, and
 * `activeElement` falls back to `<body>`.
 *
 * Visibility is the one that is not obvious, and `isConnected` alone is wrong
 * without it. Next keeps the page you navigated away from *mounted and hidden*
 * so that Back can be instant, so the outgoing route's DOM is still connected,
 * still answers to `getElementById`, and is still what a focus memory
 * remembers — while `focus()` on it is a silent no-op, because focusing a
 * `display: none` element does nothing and reports nothing. Measured on a real
 * Back press: the remembered element was the previous page's `<main>`,
 * `isConnected` true, `checkVisibility()` false, and the focus attempt retried
 * for its entire budget without ever landing.
 *
 * `checkVisibility` is unavailable in jsdom, which performs no layout and in
 * which `offsetParent` is `null` for everything — so there, absence is read as
 * visible. That is the honest default for an environment that cannot answer the
 * question, and it is why the claims that depend on it are asserted in
 * `e2e/focus-management.spec.ts` and `e2e/a11y-journey.spec.ts` rather than in
 * the unit suite.
 */
export function canTakeFocus(element: HTMLElement): boolean {
  if (!element.isConnected) return false;

  const checkVisibility = element.checkVisibility?.bind(element);
  if (checkVisibility === undefined) return true;

  return checkVisibility({
    checkVisibilityCSS: true,
    contentVisibilityAuto: true,
  });
}

/**
 * The things a `Tab` press can reach, in document order.
 *
 * `[tabindex]:not([tabindex="-1"])` rather than `[tabindex]`: a container that
 * exists only to be focused programmatically carries `tabindex="-1"`, and
 * `<DialogContent>` is exactly that. Including it would put the panel itself
 * into the tab cycle ahead of its own first control, so the first `Tab` after
 * opening a dialog would appear to do nothing.
 *
 * `:not([disabled])` covers the form controls; `details`, `embed` and the
 * `contenteditable` host are omitted because nothing in this application uses
 * them and a selector listing elements that cannot occur is a selector nobody
 * can verify.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Every focusable descendant of `container`, in document order, filtered to the
 * ones that can really take the focus.
 *
 * The filter matters more here than the selector does. A dialog's own close
 * button is in the DOM from the moment the panel renders, and a control inside
 * a collapsed section of it matches the selector while being unreachable —
 * wrapping a tab cycle onto one of those is a cycle with a dead stop in it.
 */
export function focusableWithin(
  container: HTMLElement,
): readonly HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(canTakeFocus);
}
