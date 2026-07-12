import type { Metadata } from "next";
import Link from "next/link";
import { getPublishedPosts } from "@/lib/dal/posts";
import { IsrBadge } from "./_components/isr-badge";
import { RevalidateButton } from "./_components/revalidate-button";

export const metadata: Metadata = {
  title: "Blog",
  description: "Browse published posts — served via Incremental Static Regeneration",
};

/**
 * ISR: this page is statically generated at build time and revalidated every
 * 60 seconds on the next request after the TTL expires. Stale content is served
 * immediately while Next.js regenerates in the background.
 */
export const revalidate = 60;

export default async function BlogPage() {
  const posts = await getPublishedPosts();
  const renderedAt = new Date();

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Published Posts</h1>
            <p className="mt-1 text-sm" style={{ color: "var(--muted-foreground)" }}>
              {posts.length === 0
                ? "No published posts yet."
                : `${posts.length} post${posts.length === 1 ? "" : "s"} available`}
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
          <strong className="font-semibold" style={{ color: "var(--foreground)" }}>
            ISR demo:
          </strong>{" "}
          This page is statically generated and revalidates every{" "}
          <code className="rounded px-1 font-mono text-xs" style={{ backgroundColor: "var(--border)" }}>
            60s
          </code>{" "}
          via{" "}
          <code className="rounded px-1 font-mono text-xs" style={{ backgroundColor: "var(--border)" }}>
            export const revalidate = 60
          </code>
          . The &quot;Rendered at&quot; badge updates on each regeneration. Use the button
          below to trigger on-demand revalidation via{" "}
          <code className="rounded px-1 font-mono text-xs" style={{ backgroundColor: "var(--border)" }}>
            revalidatePath
          </code>
          .
        </div>

        <RevalidateButton path="/blog" label="Revalidate /blog now" />
      </div>

      {posts.length === 0 ? (
        <p className="py-12 text-center" style={{ color: "var(--muted-foreground)" }}>
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
                <span className="text-lg font-semibold leading-snug group-hover:underline">
                  {post.title}
                </span>
                <span className="text-sm" style={{ color: "var(--muted-foreground)" }}>
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
