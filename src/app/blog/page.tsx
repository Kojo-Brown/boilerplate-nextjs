import type { Metadata } from "next";
import Link from "next/link";
import { getBlogIndex } from "@/lib/cache/blog";
import { BLOG_POSTS_TAG } from "@/lib/cache/tags";
import { PreviewBanner } from "@/components/preview/preview-banner";
import { DraftBadge } from "@/components/preview/draft-badge";
import { IsrBadge } from "./_components/isr-badge";
import { RevalidateButton } from "./_components/revalidate-button";

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Browse published posts — served via Incremental Static Regeneration",
};

/**
 * ISR under Cache Components. The 60-second window that used to live here as
 * `export const revalidate = 60` — a route segment config Cache Components
 * rejects outright — now lives on `getCachedPublishedPosts`, which also stamps
 * the render time so the badge reflects the cache entry rather than the request.
 *
 * `getBlogIndex` picks between that cached read and an uncached one that also
 * returns drafts, according to whether this request is a preview. The route
 * stays statically prerendered either way; `@/lib/preview/draft` has the reason
 * that is possible.
 */
export default async function BlogPage() {
  const { data: posts, renderedAt } = await getBlogIndex();
  const draftCount = posts.filter((post) => !post.published).length;

  return (
    <div className="flex flex-col gap-8">
      <PreviewBanner returnTo="/blog" />

      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              {draftCount > 0 ? "All Posts" : "Published Posts"}
            </h1>
            <p
              className="mt-1 text-sm"
              style={{ color: "var(--muted-foreground)" }}
            >
              {/* The heading and this line are derived from the posts actually
                  in hand rather than from `isPreviewEnabled()` a second time.
                  Reading the flag once, in the data layer, is what keeps "what
                  is on this page" and "what this page says about itself" from
                  being able to disagree. */}
              {posts.length === 0
                ? "No published posts yet."
                : `${posts.length} post${posts.length === 1 ? "" : "s"} available` +
                  (draftCount > 0 ? ` · ${draftCount} unpublished` : "")}
            </p>
          </div>
          <IsrBadge renderedAt={renderedAt} revalidateSeconds={60} />
        </div>

        {/* ISR explanation callout */}
        <div
          className="rounded-lg border px-4 py-3 text-sm"
          style={{
            borderColor: "var(--border)",
            backgroundColor: "var(--muted)",
            color: "var(--muted-foreground)",
          }}
        >
          <strong
            className="font-semibold"
            style={{ color: "var(--foreground)" }}
          >
            ISR demo:
          </strong>{" "}
          This page is statically generated and revalidates every{" "}
          <code
            className="rounded px-1 font-mono text-xs"
            style={{ backgroundColor: "var(--border)" }}
          >
            60s
          </code>{" "}
          via{" "}
          <code
            className="rounded px-1 font-mono text-xs"
            style={{ backgroundColor: "var(--border)" }}
          >
            cacheLife
          </code>{" "}
          on the cached read. The &quot;Rendered at&quot; badge updates on each
          regeneration. Publishing a post invalidates this page immediately, and
          so does the button below — both drop the{" "}
          <code
            className="rounded px-1 font-mono text-xs"
            style={{ backgroundColor: "var(--border)" }}
          >
            {BLOG_POSTS_TAG}
          </code>{" "}
          cache tag.
        </div>

        <RevalidateButton path="/blog" label="Revalidate /blog now" />
      </div>

      {posts.length === 0 ? (
        <p
          className="py-12 text-center"
          style={{ color: "var(--muted-foreground)" }}
        >
          Publish a post from the dashboard to see it here.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {posts.map((post) => (
            <li key={post.id}>
              <Link
                href={`/blog/${post.id}`}
                className="group flex flex-col gap-1 rounded-xl border p-5 transition-shadow hover:shadow-md"
                style={{ borderColor: "var(--border)" }}
              >
                <span className="flex items-center gap-2">
                  <span className="text-lg font-semibold leading-snug group-hover:underline">
                    {post.title}
                  </span>
                  {!post.published && <DraftBadge />}
                </span>
                <span
                  className="text-sm"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  By {post.author.name ?? post.author.email} ·{" "}
                  {new Date(post.createdAt).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
