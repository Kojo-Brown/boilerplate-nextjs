/**
 * Which element last had focus on each route.
 *
 * This is the other half of restoring focus on a Back press: the policy in
 * `./route-focus` decides *whether* to restore, and this decides *to what*.
 * It is a module of its own because it is the part with the two conditions
 * that are easy to get wrong and impossible to observe from the outside —
 * `<body>` and a detached node — and both are testable here in three lines
 * each, where a component test of the same thing has to arrange a navigation
 * and then cannot tell the fallback from the restore.
 */

/** Keyed by pathname, so a route remembers its own focus and nothing else's. */
export type FocusMemory = Map<string, WeakRef<HTMLElement>>;

export function createFocusMemory(): FocusMemory {
  return new Map();
}

/**
 * Record `target` as the element focused on `pathname`.
 *
 * Returns whether anything was recorded, which is what the tests assert on:
 * the interesting behaviour here is the refusals.
 *
 * `<body>` is refused. It becomes `document.activeElement` whenever a focused
 * element is removed from the document, which happens on every navigation —
 * so without this, every route's memory is the body within a frame of leaving
 * it, every Back press "restores" focus to the body, and the `<main>` fallback
 * that would have been correct is suppressed by a target that does nothing.
 *
 * `WeakRef` and not the element: this map is never pruned, and a long session
 * would otherwise pin one detached DOM subtree per route visited.
 */
export function rememberFocusedElement(
  memory: FocusMemory,
  pathname: string,
  target: EventTarget | null,
): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target === target.ownerDocument.body) return false;

  memory.set(pathname, new WeakRef(target));
  return true;
}

/**
 * Whether an element can actually take the focus.
 *
 * Two conditions, and the second one cost a browser to find.
 *
 * `isConnected` is the obvious one: a `WeakRef` keeps dereferencing for as
 * long as anything at all holds the node — a React fiber, an event handler
 * closure, this very map — so a node removed from the document still derefs
 * to a live object. Focusing it moves focus to nowhere, and `activeElement`
 * falls back to `<body>`.
 *
 * Visibility is the one that is not obvious, and `isConnected` alone is
 * wrong without it. Next keeps the page you navigated away from *mounted and
 * hidden* so that Back can be instant, so the outgoing route's DOM is still
 * connected, still answers to `getElementById`, and is still what this map
 * remembers — while `focus()` on it is a silent no-op, because focusing a
 * `display: none` element does nothing and reports nothing. Measured on a
 * real Back press: the remembered element was the previous page's `<main>`,
 * `isConnected` true, `checkVisibility()` false, and the focus attempt
 * retried for its entire budget without ever landing.
 *
 * `checkVisibility` is unavailable in jsdom, which performs no layout and in
 * which `offsetParent` is `null` for everything — so there, absence is read
 * as visible. That is the honest default for an environment that cannot
 * answer the question, and it is why the claim this guard makes is asserted
 * in `e2e/focus-management.spec.ts` rather than in the unit suite.
 */
function canTakeFocus(element: HTMLElement): boolean {
  if (!element.isConnected) return false;

  const checkVisibility = element.checkVisibility?.bind(element);
  if (checkVisibility === undefined) return true;

  return checkVisibility({
    checkVisibilityCSS: true,
    contentVisibilityAuto: true,
  });
}

/**
 * The element to return focus to on `pathname`, if there still is one.
 *
 * The case worth having is the gallery under an intercepted photo: it is
 * never unmounted and never hidden, so dismissing the modal with Back finds
 * the exact tile that opened it. Everything else falls through to `null`, and
 * the caller focuses the route's landmark instead — which is the right answer
 * for a route whose DOM was rebuilt while the visitor was away.
 */
export function recallFocusedElement(
  memory: FocusMemory,
  pathname: string,
): HTMLElement | null {
  const remembered = memory.get(pathname)?.deref();
  if (remembered === undefined) return null;
  return canTakeFocus(remembered) ? remembered : null;
}
