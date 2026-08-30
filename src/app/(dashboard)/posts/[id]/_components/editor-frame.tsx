import type { ReactNode } from "react";
import Link from "next/link";

/**
 * The part of `/posts/[id]` that is identical for every visitor and every post.
 *
 * Shared by `page.tsx` and `loading.tsx` so a soft navigation into the editor
 * and a fresh request for it show the same frame — the same reason
 * `PostsFrame` exists one directory up. See `docs/streaming.md`.
 */
export function EditorFrame({ editor }: { editor: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <nav aria-label="Breadcrumb" className="text-xs">
        <Link
          href="/posts"
          className="hover:underline"
          style={{ color: "var(--muted-foreground)" }}
        >
          Posts
        </Link>
      </nav>
      <h1 className="text-2xl font-bold tracking-tight">Edit Post</h1>
      <div className="mt-6">{editor}</div>
    </div>
  );
}
