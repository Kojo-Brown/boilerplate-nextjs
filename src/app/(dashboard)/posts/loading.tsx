import { PostsFrame } from "./_components/posts-frame";
import { PostsSectionFallback } from "./_components/posts-section";

/**
 * Renders the same frame as the prerendered shell and the same fallback as the
 * page's own boundary, so a soft navigation into `/posts` and a fresh request
 * for it show the same thing.
 */
export default function PostsLoading() {
  return <PostsFrame section={<PostsSectionFallback />} />;
}
