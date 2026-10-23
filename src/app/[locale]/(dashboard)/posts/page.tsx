import type { Metadata } from "next";
import { Suspense } from "react";
import { PostsFrame } from "./_components/posts-frame";
import {
  PostsSection,
  PostsSectionFallback,
} from "./_components/posts-section";

export const metadata: Metadata = {
  title: "Posts",
  description: "Browse and manage posts",
};

/**
 * Synchronous on purpose — see `docs/streaming.md`.
 *
 * The session read and the query it feeds now live in `<PostsSection>`, behind
 * a boundary. `/posts` is the route whose shell this repository has measured
 * twice: 2.6 KB when the dashboard layout read the session, and 7.8 KB of pure
 * chrome once that moved into `<UserChip>` — chrome, because the page's own
 * heading was still behind `await getRequiredSession()` here.
 */
export default function PostsPage() {
  return (
    <PostsFrame
      section={
        <Suspense fallback={<PostsSectionFallback />}>
          <PostsSection />
        </Suspense>
      }
    />
  );
}
