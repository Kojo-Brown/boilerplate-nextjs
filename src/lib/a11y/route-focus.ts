/**
 * What a client-side navigation should do with the keyboard focus.
 *
 * Separated from the component that performs the move because every
 * interesting part of this feature is the *decision*, and the decision is
 * four booleans wide. A test that has to mount a router, portal a dialog and
 * dispatch a `popstate` to find out whether a hash navigation steals focus is
 * a test nobody writes twice.
 *
 * The problem this exists to solve: `<Link>` replaces the document's content
 * without reloading it, so nothing resets the focus. The browser's own
 * behaviour on a full page load — focus back to the top of the new document —
 * does not happen, and focus is left on the link that was activated, which is
 * usually a navigation item in a sidebar that is still there. For a keyboard
 * user the next Tab continues from the middle of the chrome; for a screen
 * reader user the virtual cursor stays where it was and the new page is not
 * read at all. WCAG 2.4.3 (Focus Order) is the criterion; the practical
 * symptom is that keyboard navigation of a single-page application silently
 * stops working after the first route change.
 */

/**
 * The id of the one focusable landmark every route renders.
 *
 * It is a single constant rather than a per-route id because it is also the
 * skip link's target, and a skip link whose destination depends on the route
 * is a skip link that is broken on the route that forgot to provide one.
 * `<MainContent>` is the only thing that may render it — `scripts/assert-focus-management.ts`
 * fails on a second occurrence in any document, since two elements with the
 * same id make the fragment target whichever one the browser saw first.
 */
export const MAIN_CONTENT_ID = "main-content";

/** The skip link's `href`. Same-document fragment, so no router involved. */
export const SKIP_LINK_HREF = `#${MAIN_CONTENT_ID}`;

/**
 * Why focus was moved, or why it was left alone.
 *
 * A discriminated union rather than a boolean so the component can be tested
 * on the reason and not only the outcome. "Focus did not move" is the correct
 * result for three completely different situations, and a test asserting the
 * bare negative passes when the wrong one of them fires.
 */
export type RouteFocusDecision =
  /** Leave focus alone. */
  | { readonly action: "keep"; readonly reason: KeepReason }
  /** Focus the element that last had it on the route being returned to. */
  | { readonly action: "restore"; readonly reason: "history-pop" }
  /** Focus the route's `<main>` landmark. */
  | { readonly action: "main"; readonly reason: MainReason };

export type KeepReason =
  /**
   * The first render. A full page load already focuses the document, and the
   * screen reader is reading the page the visitor just asked for — taking the
   * cursor to `<main>` at that moment skips the heading they were about to
   * hear and the skip link they might have wanted.
   */
  | "first-render"
  /**
   * The pathname did not change. Search params did: a filter, a page number,
   * a sort order. Those are in-place updates to a view the visitor is looking
   * at, and moving focus out of the control they just operated is how a
   * paginator becomes unusable with a keyboard.
   */
  | "same-pathname"
  /**
   * The URL carries a fragment, so the browser has its own target and will
   * focus it. This is also what the skip link produces, which makes the rule
   * load-bearing: without it, activating "Skip to content" would be followed
   * by this component focusing `<main>` a frame later — harmless there, and
   * wrong for every anchor that points anywhere else.
   */
  | "hash-target"
  /**
   * Something on the destination manages focus itself and said so. The modal
   * that `@modal/(.)photos/[id]` renders is the case in this application: it
   * is a route change *and* a dialog, the dialog moves focus into itself, and
   * two components moving focus in the same commit means the one that happens
   * to run last wins. See `./focus-ownership`.
   */
  | "focus-owned";

export type MainReason =
  /** An ordinary forward navigation. */
  | "navigation"
  /**
   * A history pop with nothing to go back to: the element that had focus is
   * gone from the document, or there never was one because the previous visit
   * to this route ended without anything being focused.
   */
  | "history-pop-without-target";

export interface RouteFocusInput {
  /** The pathname this component last saw, or `null` on the first render. */
  readonly previousPathname: string | null;
  /** The pathname now. */
  readonly pathname: string;
  /** `location.hash`, including the leading `#`, or `""`. */
  readonly hash: string;
  /** Whether the navigation that produced this change was a history pop. */
  readonly isHistoryPop: boolean;
  /** Whether a component on the destination has claimed focus. */
  readonly isFocusOwned: boolean;
  /**
   * Whether an element that previously had focus on this pathname is still in
   * the document and can be focused again.
   */
  readonly hasRestorableTarget: boolean;
}

/**
 * The whole policy, in evaluation order.
 *
 * Order matters and is not arbitrary:
 *
 *  - `first-render` is first because none of the other inputs mean anything
 *    before there is a previous route to have left.
 *  - `same-pathname` is next so that a search-param change can never reach the
 *    dialog or hash rules and be mistaken for a navigation.
 *  - `hash-target` precedes `focus-owned` because the browser's own fragment
 *    behaviour is not something this component can override anyway.
 *  - `focus-owned` precedes the restore so that dismissing a dialog by
 *    navigating *forward* does not hand focus to a stale element behind it.
 */
export function decideRouteFocus(input: RouteFocusInput): RouteFocusDecision {
  if (input.previousPathname === null) {
    return { action: "keep", reason: "first-render" };
  }
  if (input.previousPathname === input.pathname) {
    return { action: "keep", reason: "same-pathname" };
  }
  if (input.hash !== "") {
    return { action: "keep", reason: "hash-target" };
  }
  if (input.isFocusOwned) {
    return { action: "keep", reason: "focus-owned" };
  }
  if (input.isHistoryPop) {
    return input.hasRestorableTarget
      ? { action: "restore", reason: "history-pop" }
      : { action: "main", reason: "history-pop-without-target" };
  }
  return { action: "main", reason: "navigation" };
}
