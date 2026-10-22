"use client";

import { useTransition } from "react";
import { revalidateBlogAction } from "@/actions/blog";

export function RevalidateButton({ path, label }: { path: string; label: string }) {
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      await revalidateBlogAction(path);
    });
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className="w-fit rounded-lg border px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
      style={{ borderColor: "var(--border)" }}
    >
      {isPending ? "Revalidating…" : label}
    </button>
  );
}
