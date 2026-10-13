"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { useIsHydrated } from "@/hooks/use-is-hydrated";
import {
  createFocusMemory,
  recallFocusedElement,
  rememberFocusedElement,
} from "@/lib/a11y/focus-memory";
import { isFocusOwned } from "@/lib/a11y/focus-ownership";
import { MAIN_CONTENT_ID, decideRouteFocus } from "@/lib/a11y/route-focus";

/**
 * Moves the keyboard focus when the route changes. Renders nothing.
 *
 * Mounted once, in the root layout, because it has to observe every
 * navigation in the application and a layout does not re-render when the
 * visitor moves between sibling routes inside it — the same property that
 * keeps the session read out of `(dashboard)/layout.tsx`. One mount at the
 * root is also what makes the "previous pathname" it compares against mean
 * anything: a copy per route group would see its own first render on every
 * crossing between them and decline to move focus, which is the bug it
 * exists to fix, reintroduced at the boundary nobody tests.
 *
 * The policy is in `@/lib/a11y/route-focus`. What is here is the three
 * observations that policy needs and the move itself.
 *
 * **Why `requestAnimationFrame`.** Both halves of this are about ordering.
 * A dialog's claim on the focus (`@/lib/a11y/focus-ownership`) is made in that
 * dialog's own mount effect, and whether that effect runs before this one
 * depends on where the two components sit in the tree — this is a sibling of
 * the `@modal` slot, not an ancestor, so React's child-first ordering says
 * nothing useful about which wins. Deferring to the next frame puts the read
 * after every effect in the commit, so the answer no longer depends on
 * composition. It also puts the focus move after the browser has processed
 * the fragment of a `#hash` URL, which is what makes the `hash-target` rule
 * able to observe a hash at all.
 *
 * **Why `preventScroll`.** The router already owns the scroll position: it
 * scrolls to the top on a push and restores the previous offset on a pop.
 * Focusing an element scrolls it into view by default, so without this the
 * two fight on every Back press — the page is restored to where the visitor
 * left it and then yanked to the top, which is a worse experience than no
 * focus management at all and is reported as a scroll bug rather than an
 * accessibility one.
 */
/**
 * How long to keep trying to land the focus after a navigation.
 *
 * Long enough to cover a streamed route arriving over a slow connection,
 * short enough that a visitor who has started reading is not interrupted —
 * and the input listeners stop it sooner than this in every case where
 * someone is actually doing something. It is a ceiling on an attempt that
 * normally succeeds on the first or second frame, not a delay anyone waits.
 */
const SETTLE_BUDGET_MS = 1_000;

function RouteFocusEffects() {
  const pathname = usePathname();

  /** The pathname of the previous commit; `null` until the first one lands. */
  const previousPathnameRef = React.useRef<string | null>(null);
  /**
   * The pathname focus events should be filed under.
   *
   * Tracked separately from `previousPathnameRef` because the two answer
   * different questions at different times: this one is "where is the visitor
   * now", read by the `focusin` listener, and it is deliberately updated at
   * the end of the navigation effect so that the click which *caused* a
   * navigation is still filed against the route it was clicked on.
   */
  const currentPathnameRef = React.useRef<string>(pathname);
  /** Whether the navigation now being handled came from the history stack. */
  const isHistoryPopRef = React.useRef(false);
  /** The last element focused on each pathname. See `@/lib/a11y/focus-memory`. */
  const focusMemoryRef = React.useRef(createFocusMemory());

  // `popstate` is the only signal that distinguishes Back from a `<Link>`.
  // The router does not expose it: `usePathname` reports the destination
  // identically either way, and the destination is not enough to decide —
  // restoring focus to a remembered element is right when returning to a
  // route and wrong when arriving at it, and those are the same pathname.
  //
  // The flag is read in the deferred callback below rather than in the effect
  // body, and that is not a detail. Next registers its own `popstate`
  // listener before this one and dispatches the router update from inside it,
  // and React flushes a `popstate` update synchronously — so the effect body
  // for the popped route runs *inside* Next's handler, several listeners
  // before this one is reached. Read there, the flag is always `false` and
  // every Back press looks like a forward navigation. It cost a browser to
  // find: the unit suite had set the flag before re-rendering, which is the
  // one order that cannot happen.
  React.useEffect(() => {
    function onPopState(): void {
      isHistoryPopRef.current = true;
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // `focusin` and not `focus`: `focus` does not bubble, so a listener on
  // `document` would only ever see the document itself gain focus.
  React.useEffect(() => {
    function onFocusIn(event: FocusEvent): void {
      rememberFocusedElement(
        focusMemoryRef.current,
        currentPathnameRef.current,
        event.target,
      );
    }
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  React.useEffect(() => {
    const previousPathname = previousPathnameRef.current;
    previousPathnameRef.current = pathname;

    let frame = 0;
    let abandoned = false;
    const deadline = Date.now() + SETTLE_BUDGET_MS;

    // The visitor did something of their own while we were waiting. Whatever
    // they clicked or typed into is where the focus belongs now, and moving it
    // to a landmark at that point is worse than never having tried.
    function abandon(): void {
      abandoned = true;
    }

    /** Nothing more to try on this navigation. */
    function finish(): void {
      abandoned = true;
      isHistoryPopRef.current = false;
    }

    function attempt(): void {
      if (abandoned) return;

      const restorable = recallFocusedElement(focusMemoryRef.current, pathname);
      const decision = decideRouteFocus({
        previousPathname,
        pathname,
        hash: window.location.hash,
        isHistoryPop: isHistoryPopRef.current,
        // Re-read on every attempt rather than once. A dialog that arrives as
        // a streamed hole — which is what `@modal/(.)photos/[id]` is — claims
        // the focus several frames after the pathname changed, so a single
        // read at the start of the navigation is taken before the answer
        // exists.
        isFocusOwned: isFocusOwned(),
        hasRestorableTarget: restorable !== null,
      });

      if (decision.action === "keep") {
        finish();
        return;
      }

      const target =
        decision.action === "restore"
          ? restorable
          : document.getElementById(MAIN_CONTENT_ID);

      target?.focus({ preventScroll: true });

      if (document.activeElement === target) {
        finish();
        return;
      }

      // Not landed. Almost always because the destination has not committed
      // yet: `usePathname()` reports the new route as soon as the transition
      // starts, while the DOM is still the previous page's — and React hides
      // outgoing content with `display: none`, which makes `focus()` a silent
      // no-op on an element that is still in the document and still answers
      // to `getElementById`. One frame of waiting is not enough, and the only
      // way to know it did not work is to look at `document.activeElement`
      // afterwards: `focus()` neither throws nor returns anything.
      if (Date.now() < deadline) {
        frame = requestAnimationFrame(attempt);
      } else {
        finish();
      }
    }

    window.addEventListener("pointerdown", abandon, { once: true });
    window.addEventListener("keydown", abandon, { once: true });
    frame = requestAnimationFrame(attempt);

    currentPathnameRef.current = pathname;

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", abandon);
      window.removeEventListener("keydown", abandon);
    };
  }, [pathname]);

  return null;
}

/**
 * Mounts the focus manager, but only once there is a client to manage.
 *
 * The gate is not about readiness, it is about `usePathname()`. That hook
 * cannot be answered while prerendering a *fallback shell* — the document a
 * dynamic segment builds for params it has not seen — so a client component
 * that calls it suspends during the build. At the root of the tree, that takes
 * the root of `/blog/[slug]`, `/photos/[id]`, `/posts/[id]` and
 * `/pricing/v/[variant]` with it: the four shells prerender empty, which is
 * the failure `assert-streaming-boundaries.ts` exists to catch, caused by an
 * accessibility component. `NavLinks` has the same property for the same
 * reason; see docs/streaming.md.
 *
 * A `<Suspense fallback={null}>` around it was the first fix and it is the
 * wrong one: it contains the suspension, and leaves a pending boundary with an
 * empty fallback in every shell — which that same gate also fails, correctly,
 * because a hole with nothing in it paints as collapsed space and then pushes
 * the page around when it fills. The boundary was not buying anything either
 * way, because there is nothing to show while waiting.
 *
 * Not rendering the hook at all until hydration avoids both. Nothing is lost:
 * there are no client-side navigations before the client exists, and the
 * manager's first render is a no-op by design.
 */
export function RouteFocus() {
  return useIsHydrated() ? <RouteFocusEffects /> : null;
}
