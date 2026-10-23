import type { ReactNode } from "react";

/**
 * The part of `/posts` that is identical for every visitor.
 *
 * Shared by `page.tsx` and `loading.tsx` so the prerendered shell and the
 * client-navigation fallback are the same tree — see `docs/streaming.md`.
 */
export function PostsFrame({ section }: { section: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-bold tracking-tight">Posts</h1>
      {section}
    </div>
  );
}
