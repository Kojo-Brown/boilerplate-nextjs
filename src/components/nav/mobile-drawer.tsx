"use client";

import React from "react";
import { createPortal } from "react-dom";
import { useIsHydrated } from "@/hooks/use-is-hydrated";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { NavLinks } from "./nav-links";

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  appName?: string;
}

export function MobileDrawer({
  open,
  onClose,
  appName = "App",
}: MobileDrawerProps) {
  const hydrated = useIsHydrated();
  const [panel, setPanel] = React.useState<HTMLDivElement | null>(null);

  // The drawer declared `aria-modal="true"` and left the focus on the trigger
  // behind it, which that attribute tells a screen reader to ignore. Same
  // defect as `<DialogContent>`'s and the same fix; see the hook.
  useModalFocus(open, panel);

  React.useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!hydrated || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 lg:hidden">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={setPanel}
        // The target of the trigger's `aria-controls` in `app-shell.tsx`. It
        // was dangling: this panel had no id, so the attribute named an element
        // that does not exist. axe skips that check while `aria-expanded` is
        // `false`, on the reasonable assumption that a collapsed control may
        // not have rendered its target yet — which is why nothing caught it
        // until a suite opened the drawer and audited it.
        id="mobile-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        // So `useModalFocus` can fall back to the panel. The drawer always
        // renders a close button, so the fallback is unreachable today; it is
        // here because the alternative to a focusable container is a `Tab`
        // that escapes the overlay, and that should not depend on the contents
        // staying as they are.
        tabIndex={-1}
        className="absolute inset-y-0 start-0 flex w-64 flex-col border-e shadow-xl"
        style={{ backgroundColor: "var(--background)" }}
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="font-semibold tracking-tight">{appName}</span>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={onClose}
            className="rounded-md p-1.5 transition-colors hover:bg-[var(--muted)]"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <NavLinks onNavigate={onClose} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
