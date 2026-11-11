"use client";

import * as React from "react";
import { canTakeFocus, focusableWithin } from "@/lib/a11y/focus-target";

/**
 * The three focus obligations of an `aria-modal` overlay: move focus in, keep
 * it in, give it back.
 *
 * Both overlays in this application declared `aria-modal="true"` and did none
 * of the three. That combination is worse than a non-modal dialog, because
 * `aria-modal` is an instruction to assistive technology to ignore everything
 * outside the dialog — so the element that still had the focus, the trigger
 * that opened it, was both focused and unreachable. A screen reader user
 * arrived on a control it had been told not to announce, and `Tab` walked out
 * of the dialog into a page the same attribute had just hidden.
 *
 * `e2e/a11y-journey.spec.ts` is what found it, and it is the kind of thing only
 * a browser can find: axe automates no focus-trap rule, the attributes are all
 * individually correct, and the unit suites for both components passed. jsdom
 * cannot help either — it has no sequential focus navigation at all, so `Tab`
 * moves nothing there and a trap is untestable by construction. The unit suite
 * here covers the parts that are decisions (what gets focused, what focus is
 * returned to, what happens when the trigger is gone); the wrap itself is
 * asserted end to end.
 *
 * ## Why a keydown listener and not `inert`
 *
 * Marking the rest of the document `inert` would be fewer lines and is the
 * modern answer. It is not usable here: both overlays portal into
 * `document.body` as a sibling of the application root, so "the rest of the
 * document" is not a single subtree this hook can reach without knowing where
 * the application mounts — and `<dialog>` with `showModal()`, which would get
 * all of this from the platform, is a larger change to two components than the
 * behaviour is worth. The listener is on the container, so it costs nothing
 * when no dialog is open.
 *
 * @param open    Whether the overlay is showing.
 * @param container The overlay's focusable root. `null` until it renders, which
 *                  for a portalled overlay means until after hydration.
 */
/**
 * How many recently focused elements to keep. Small on purpose: the only reason
 * for more than one is the handful of focus events a single commit can produce,
 * and a longer history would start restoring the focus to somewhere the visitor
 * has genuinely moved on from.
 */
const HISTORY = 8;

/**
 * The most recently focused element that is not inside `container`.
 *
 * Walking backwards rather than taking the last entry, because the commit that
 * opens an overlay can move the focus into it before this hook's effects run —
 * `autoFocus` on a field inside the panel does exactly that — and the
 * `focusin` listener is still attached at that point, so the newest entry is
 * frequently the panel's own input. Measured: the history at that moment is
 * `[…, button "New Post", input#post-title, input#post-title]`, and the
 * trigger is the third entry from the end.
 */
function lastOutside(
  container: HTMLElement,
  history: readonly HTMLElement[],
): HTMLElement | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const candidate = history[i];
    if (candidate !== undefined && !container.contains(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function useModalFocus(
  open: boolean,
  container: HTMLElement | null,
): void {
  /**
   * The elements focused recently, oldest first.
   *
   * A history and not a single "last focused outside", because by the time this
   * hook's open effect runs the focus may already be inside the overlay and the
   * trigger is then unrecoverable. The create-post dialog is that case: its
   * title field carries `autoFocus`, React applies it during the commit that
   * inserts the panel, and passive effects — including the cleanup that would
   * detach the listener below — run afterwards. So the newest entry at that
   * moment is an `<input>` inside the panel, and `lastOutside` is what skips
   * back over it.
   *
   * Two earlier drafts failed here, each in a way that looked like it worked:
   * reading `activeElement` in the open effect recorded the panel's own input,
   * and recording only the single most recent focus recorded the same thing.
   * Both produced an overlay that trapped the focus correctly and then dropped
   * it on `<body>` when it closed.
   */
  const recentlyFocused = React.useRef<HTMLElement[]>([]);
  /** Pinned at the moment of opening, so it survives this effect re-running. */
  const restoreTo = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (open) return;
    const doc = document;
    const remember = (): void => {
      const active = doc.activeElement;
      // `<body>` is refused for the same reason `focus-memory` refuses it: it
      // becomes `activeElement` whenever a focused element is removed, so
      // without this the history fills with the body within a frame of any
      // teardown.
      if (!(active instanceof HTMLElement) || active === doc.body) return;
      const history = recentlyFocused.current;
      if (history[history.length - 1] === active) return;
      history.push(active);
      if (history.length > HISTORY) history.shift();
    };
    remember();
    doc.addEventListener("focusin", remember);
    return () => {
      doc.removeEventListener("focusin", remember);
    };
  }, [open]);

  React.useEffect(() => {
    if (!open || container === null) return;

    // Recorded once per open. This effect re-runs while the overlay stays open:
    // `container` arrives as state, and a callback ref is called with `null`
    // before the node, so there is an intermediate render in which it is
    // `null`, the effect tears down, and then runs again.
    // Spelled out rather than `??=`, which React Compiler cannot lower
    // (`BuildHIR::lowerExpression`). A construct it cannot handle is skipped
    // silently, so the whole hook would ship with no memoization at all —
    // `scripts/assert-react-compiler.ts` rule R4 is what caught it. See
    // docs/react-compiler.md.
    if (restoreTo.current === null) {
      restoreTo.current = lastOutside(container, recentlyFocused.current);
    }

    const doc = container.ownerDocument;
    const active = doc.activeElement;

    // Only move the focus if the overlay does not already have it. A dialog
    // whose content placed its own focus has made a better decision than this
    // hook can: `autoFocus` on the create-post dialog's title field puts the
    // caret where someone is about to type, and the first focusable element in
    // the panel is the close button, so taking over here would move the focus
    // from the field to the X — a regression delivered by an accessibility fix.
    if (!(active instanceof HTMLElement) || !container.contains(active)) {
      // The first control, or the panel itself. The panel is the fallback and
      // not the preference: a focused panel announces the dialog and then needs
      // a `Tab` before anything can be typed. `<DialogContent>` carries
      // `tabIndex={-1}` precisely so this exists for a dialog with no controls.
      const first = focusableWithin(container)[0];
      (first ?? container).focus();
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;

      // Recomputed per keypress rather than captured above: a dialog's content
      // is not static — the posts dialog disables its submit button while the
      // mutation is in flight, which removes it from this list and puts it
      // back. A list captured when the dialog opened would wrap onto a control
      // that cannot take the focus.
      const focusable = focusableWithin(container);
      if (focusable.length === 0) {
        // Nothing to cycle through, so the only correct behaviour is to keep
        // the focus on the panel rather than let `Tab` leave the overlay.
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;

      const inside = doc.activeElement;

      // Written in terms of "where would Tab go from here" rather than "which
      // end are we at", because the focus can legitimately be on the panel
      // itself — the fallback above — and the panel is at neither end.
      if (event.shiftKey) {
        if (inside === first || inside === container) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (inside === last) {
        event.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
    };
  }, [open, container]);

  React.useEffect(() => {
    if (open) return;
    const target = restoreTo.current;
    restoreTo.current = null;
    // Guarded, because the trigger is frequently gone by now and `focus()` on a
    // detached or hidden node is a silent no-op that leaves the focus on
    // `<body>` — the top of the document, so the next `Tab` starts the page
    // again. `canTakeFocus` is the same guard a Back press uses on a remembered
    // element, and for the same two reasons. When it refuses, the focus is
    // deliberately left where it is: the caller that removed the trigger is the
    // one that knows where it went.
    //
    // Nothing runs here when the overlay unmounts while still open, which is
    // how `<PhotoModal>` closes — dismissal there is `router.back()`, and the
    // router's own focus manager is what restores the focus to the tile that
    // opened it. See `@/lib/a11y/focus-ownership`.
    if (target !== null && canTakeFocus(target)) target.focus();
  }, [open]);
}
