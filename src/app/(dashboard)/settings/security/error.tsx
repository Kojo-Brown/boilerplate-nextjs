"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function SecuritySettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
      <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
        Something went wrong loading your security settings.
      </p>
      <Button onClick={reset} variant="outline" size="sm">
        Try again
      </Button>
    </div>
  );
}
