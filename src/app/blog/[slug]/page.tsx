import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getPublishedPosts } from "@/lib/dal/posts";
import { getCachedPost } from "@/lib/cache/blog";
import { IsrBadge } from "../_components/isr-badge";
import { RevalidateButton } from "../_components/revalidate-button";

/**
 * ISR under Cache Components.
 *
 * `export const revalidate = 300` and `export const dynamicParams = true` used
 * to live here. Cache Components rejects both as route segment config: the
 * window moved onto `getCachedPost`, and on-demand generation of unknown slugs
 * is the default for a dynamic segment, so `dynamicParams` no longer has
 * anything to say.
 */
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  // No try/catch fallback any more. It used to return `[]` when the database
  // was unreachable, which Cache Components rejects outright
  // (EmptyGenerateStaticParamsError) — and which quietly prerendered nothing on
  // every CI run, since CI built against an empty database. Failing loudly here
  // is the point: if the build cannot enumerate posts, the build is wrong.
  const posts = await getPublishedPosts();
  return posts.map((post) => ({ slug: post.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const { data: post } = await getCachedPost(slug);
  if (!post) return { title: "Post not found" };
  return {
    title: post.title,
    description:
      post.content?.slice(0, 155) ??
      `A post by ${post.author.name ?? post.author.email}`,
  };
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { data: post, renderedAt } = await getCachedPost(slug);

  if (!post || !post.published) notFound();

  return (
    <article className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <Link
          href="/blog"
          className="text-sm transition-opacity hover:opacity-80"
          style={{ color: "var(--muted-foreground)" }}
        >
          ← All posts
        </Link>

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <h1 className="text-3xl font-bold tracking-tight leading-tight max-w-2xl">
            {post.title}
          </h1>
          <IsrBadge renderedAt={renderedAt} revalidateSeconds={300} />
        </div>

        <div
          className="flex items-center gap-2 text-sm"
          style={{ color: "var(--muted-foreground)" }}
        >
          <span>By {post.author.name ?? post.author.email}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={post.createdAt.toISOString()}>
            {new Date(post.createdAt).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </time>
        </div>
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
        This page was pre-built via{" "}
        <code
          className="rounded px-1 font-mono text-xs"
          style={{ backgroundColor: "var(--border)" }}
        >
          generateStaticParams
        </code>{" "}
        and revalidates every{" "}
        <code
          className="rounded px-1 font-mono text-xs"
          style={{ backgroundColor: "var(--border)" }}
        >
          300s
        </code>
        . Unknown post IDs are generated on-demand because{" "}
        <code
          className="rounded px-1 font-mono text-xs"
          style={{ backgroundColor: "var(--border)" }}
        >
          dynamicParams = true
        </code>
        .
      </div>

      <div className="prose prose-neutral max-w-none">
        {post.content ? (
          <p className="leading-relaxed whitespace-pre-wrap">{post.content}</p>
        ) : (
          <p className="italic" style={{ color: "var(--muted-foreground)" }}>
            No content yet.
          </p>
        )}
      </div>

      <div
        className="flex flex-col gap-2 border-t pt-6"
        style={{ borderColor: "var(--border)" }}
      >
        <p className="text-sm font-medium">On-demand revalidation</p>
        <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
          Trigger an immediate cache purge without waiting for the 5-minute TTL.
        </p>
        <RevalidateButton path="/blog" label="Revalidate /blog now" />
      </div>
    </article>
  );
}
