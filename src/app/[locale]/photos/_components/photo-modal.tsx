"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useIsHydrated } from "@/hooks/use-is-hydrated";
import { claimFocusOwnership } from "@/lib/a11y/focus-ownership";

export interface PhotoModalProps {
  title: string;
  /** Announced with the dialog; the photo's caption reads well here. */
  description: string;
  children: React.ReactNode;
}

/**
 * The overlay the intercepted route renders into.
 *
 * Dismissal is `router.back()` rather than local state, and that is the part
 * worth being deliberate about: the modal exists *because* of a navigation, so
 * closing it has to be the inverse navigation. Setting `open` to `false` would
 * hide the overlay while leaving the address bar on `/photos/<id>` — a page
 * whose content is no longer on screen, and a Back press that then appears to
 * do nothing.
 *
 * `open` is therefore hard-coded. There is no closed state to model: the
 * interceptor only renders when the URL is a photo, and when it is not, the
 * `@modal` slot falls back to `default.tsx`, which renders nothing.
 *
 * `<DialogContent>` already owns Escape, the overlay click, the close button
 * and the body scroll lock; all three of the first three land here as
 * `onOpenChange(false)`.
 *
 * ---
 *
 * The focus claim is what keeps this modal and `<RouteFocus>` from fighting.
 * Arriving here *is* a route change, so the root layout's focus manager has
 * every reason to send focus to the `<main>` landmark — which on this route is
 * the gallery behind an `aria-modal` overlay, i.e. content a screen reader is
 * being told to ignore. Both components are right about their own half, and
 * which one lands last depends on where they sit in the tree rather than on
 * anything either of them decides. The claim is held for as long as the modal
 * is mounted and released on unmount, which is also the moment Back has
 * finished and the router's focus manager should take over again — and it
 * then finds the tile that opened this modal still in the document, because
 * the gallery was never unmounted. See `@/lib/a11y/focus-ownership`.
 */
export function PhotoModal({ title, description, children }: PhotoModalProps) {
  const router = useRouter();
  const contentRef = React.useRef<HTMLDivElement>(null);
  // `<DialogContent>` portals into `document.body` and renders nothing until
  // hydration, so focusing on mount would find no node. Waiting for the flip
  // is what makes the focus move reliably on the first open.
  const hydrated = useIsHydrated();

  // Claimed on mount rather than alongside the focus move below, so the claim
  // is in place even in the frame where `hydrated` is still false and there is
  // no dialog node to focus yet. A claim that arrived with the focus move
  // would leave that frame unowned, which is exactly the frame `<RouteFocus>`
  // runs in.
  React.useEffect(() => claimFocusOwnership(), []);

  React.useEffect(() => {
    if (hydrated) contentRef.current?.focus();
  }, [hydrated]);

  // Plain function, not `useCallback`. It reaches `<DialogContent>`'s effect
  // dependencies through `<Dialog>`, so the stability still matters and React
  // Compiler is what provides it. See docs/react-compiler.md.
  function handleOpenChange(open: boolean): void {
    if (!open) router.back();
  }

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent ref={contentRef} className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
