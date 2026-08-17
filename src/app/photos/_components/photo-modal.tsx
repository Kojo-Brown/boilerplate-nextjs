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
 */
export function PhotoModal({ title, description, children }: PhotoModalProps) {
  const router = useRouter();
  const contentRef = React.useRef<HTMLDivElement>(null);
  // `<DialogContent>` portals into `document.body` and renders nothing until
  // hydration, so focusing on mount would find no node. Waiting for the flip
  // is what makes the focus move reliably on the first open.
  const hydrated = useIsHydrated();

  React.useEffect(() => {
    if (hydrated) contentRef.current?.focus();
  }, [hydrated]);

  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      if (!open) router.back();
    },
    [router],
  );

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
