"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

export interface CopyLinkButtonProps {
  /** Absolute path to share, e.g. `/photos/ocean-at-sunset`. */
  path: string;
  className?: string;
}

/**
 * Copies the canonical URL of the photo currently being viewed.
 *
 * This is the point of the intercepting route, made testable. The modal is a
 * real navigation, so the address bar already reads `/photos/<id>` while it is
 * open — the button just hands that URL over. If interception ever regressed
 * into a client-side dialog, the copied link would go back to being whatever
 * page the user happened to be on, which is the failure this button makes
 * obvious.
 *
 * The origin is read from `window` rather than baked in at build time, so the
 * copied link is correct on a preview deployment and on localhost, not only in
 * production.
 */
export function CopyLinkButton({ path, className }: CopyLinkButtonProps) {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    };
  }, []);

  async function handleCopy(): Promise<void> {
    const url = new URL(path, window.location.origin).toString();

    // `navigator.clipboard` is undefined outside a secure context and rejects
    // when the document is not focused, so the failure path is a real one
    // rather than defensive padding.
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      toast.error("Could not copy the link — copy it from the address bar.");
      return;
    }

    setCopied(true);
    toast.success("Link copied");
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void handleCopy()}
      {...(className && { className })}
    >
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}
