import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getPublishedPosts } from "@/lib/dal/posts";
import { getBlogPost } from "@/lib/cache/blog";
import { PreviewBanner } from "@/components/preview/preview-banner";
import { DraftBadge } from "@/components/preview/draft-badge";
import { toParagraphs } from "@/lib/prose";
import { VideoFacade } from "@/components/third-party/video-facade";
import { getPhotoById, photoSrc } from "@/lib/photos";
import type { Photo } from "@/lib/photos";
import { IsrBadge } from "../_components/isr-badge";
import { RevalidateButton } from "../_components/revalidate-button";

/**
 * The embed this page demonstrates the facade with.
 *
 * `jNQXAC9IVRw` is "Me at the zoo", the first video uploaded to YouTube in
 * 2005 — chosen because it is about as unlikely to be taken down or made
 * private as a video gets, and a dead id here would be a broken frame that no
 * gate could catch: nothing in the build fetches it, exactly as nothing fetches
 * the Unsplash sources in `src/lib/photos.ts`.
 *
 * The poster comes from the photo catalogue rather than from YouTube's
 * thumbnail CDN, and that is the whole point rather than a convenience: taking
 * it from `i.ytimg.com` would put a request to the vendor back on every
 * article's first paint, which is most of what the facade removes. Serve the
 * poster from an origin the page already talks to. See
 * docs/third-party-scripts.md.
 */
const DEMO_VIDEO = {
  id: "jNQXAC9IVRw",
  title: "Me at the zoo — the first video uploaded to YouTube",
  posterPhotoId: "mountain-golden-hour",
} as const;

/**
 * Resolves a poster at module load, so a photo renamed out of the catalogue
 * fails the build rather than rendering a facade with a broken frame.
 *
 * `getPhotoById` rather than `PHOTOS[0]`: `noUncheckedIndexedAccess` types an
 * index read as `Photo | undefined`, and softening that with `?? something`
 * would turn a missing poster into a silently different page.
 */
function requirePhoto(id: string): Photo {
  const photo = getPhotoById(id);
  if (!photo) {
    throw new Error(
      `The video facade demo references the photo "${id}", which is not in PHOTOS.`,
    );
  }
  return photo;
}

const POSTER_PHOTO = requirePhoto(DEMO_VIDEO.posterPhotoId);

/**
 * ISR under Cache Components, plus the draft-mode read.
 *
 * `getBlogPost` returns the cached published post for a public request and an
 * uncached one — which may be unpublished — for a preview. `generateStaticParams`
 * below still enumerates published posts only: a draft has no business being
 * prerendered, and a preview reaches it through the dynamic path that any
 * unknown slug takes.
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
  const { data: post } = await getBlogPost(slug);
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
  const { data: post, renderedAt } = await getBlogPost(slug);

  // This was `if (!post || !post.published)`. Dropping the second clause is
  // only safe because the *read* now applies it: `getBlogPost` resolves to
  // `getPublishedPostById` for a public request and to the unfiltered read for
  // a preview, so by the time a post is in hand the entitlement question has
  // been answered. Relaxing the guard here before moving the filter there is
  // exactly the mistake that served an unpublished post to the public with a
  // 200 — see the note on `getPublishedPostById`.
  if (!post) notFound();

  const paragraphs = toParagraphs(post.content);

  return (
    <article className="flex flex-col gap-8">
      <PreviewBanner returnTo={`/blog/${post.id}`} />

      <div className="flex flex-col gap-4">
        <Link
          href="/blog"
          className="text-sm transition-opacity hover:opacity-80"
          style={{ color: "var(--muted-foreground)" }}
        >
          ← All posts
        </Link>

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <h1 className="flex flex-wrap items-center gap-3 text-3xl font-bold tracking-tight leading-tight max-w-2xl">
            {post.title}
            {!post.published && <DraftBadge className="align-middle" />}
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
        . A post published after the build has no prebuilt page and is rendered
        on the first request instead — the default for a dynamic segment, and
        the reason no{" "}
        <code
          className="rounded px-1 font-mono text-xs"
          style={{ backgroundColor: "var(--border)" }}
        >
          dynamicParams
        </code>{" "}
        export is needed (Cache Components rejects it as segment config). A CMS
        clears this page ahead of the window by posting a signed event to{" "}
        <code
          className="rounded px-1 font-mono text-xs"
          style={{ backgroundColor: "var(--border)" }}
        >
          /api/revalidate
        </code>
        .
      </div>

      {/* `prose-app` binds the plugin's colours to the design tokens — see the
          block of the same name in `globals.css`. It replaces `prose-neutral`,
          which named a fixed grey palette rather than this application's.
          `max-w-none` is deliberate: prose's own 65ch measure would be a
          second, narrower column inside the layout's `max-w-3xl`, which
          already sets the reading width. */}
      <div className="prose prose-app max-w-none">
        {paragraphs.length > 0 ? (
          paragraphs.map((paragraph, index) => (
            // Index keys are safe here and nowhere near a form: the list is
            // derived fresh from `post.content` on every render, never
            // reordered, and holds no state to mis-associate.
            <p key={index} className="whitespace-pre-wrap">
              {paragraph}
            </p>
          ))
        ) : (
          <p className="italic" style={{ color: "var(--muted-foreground)" }}>
            No content yet.
          </p>
        )}
      </div>

      <div
        className="flex flex-col gap-3 border-t pt-6"
        style={{ borderColor: "var(--border)" }}
      >
        <p className="text-sm font-medium">Third-party embed (facade)</p>
        <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
          Nothing is requested from the player until you press play. Until then
          this is a poster frame and a button served from this application; the
          connection to the embed origin is warmed on hover and focus, not on
          load.
        </p>
        <VideoFacade
          videoId={DEMO_VIDEO.id}
          title={DEMO_VIDEO.title}
          poster={{
            // Deliberately not `priority`: the facade sits at the foot of an
            // article, so it is never the largest contentful paint and
            // preloading it would compete with the text that is.
            src: photoSrc(POSTER_PHOTO, 1280),
            alt: POSTER_PHOTO.alt,
          }}
        />
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
