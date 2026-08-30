import type { Metadata } from "next";
import { Suspense } from "react";
import { EditorFrame } from "./_components/editor-frame";
import {
  EditorSection,
  EditorSectionFallback,
} from "./_components/editor-section";

/**
 * Static, and not `generateMetadata`.
 *
 * A generated title would mean a second read of the post — one that has to
 * repeat the ownership filter, or leak the title of a post the visitor may not
 * open through the browser tab. The editor is a private page behind
 * `PROTECTED_PREFIXES`; nothing links to it from outside and nothing unfurls
 * it, so there is no audience for a per-post title worth paying that for.
 */
export const metadata: Metadata = {
  title: "Edit Post",
  description: "Edit one of your posts",
};

/**
 * Synchronous on purpose, like `/posts` above it — see `docs/streaming.md`.
 *
 * `params` is a promise and awaiting it here would put the whole page behind
 * it. It is handed to `<EditorSection>` instead, so the breadcrumb and the
 * heading render without waiting on anything.
 */
export default function EditPostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <EditorFrame
      editor={
        <Suspense fallback={<EditorSectionFallback />}>
          <EditorSection params={params} />
        </Suspense>
      }
    />
  );
}
