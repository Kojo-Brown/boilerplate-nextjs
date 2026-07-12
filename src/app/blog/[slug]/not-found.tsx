import Link from "next/link";

export default function BlogPostNotFound() {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <h2 className="text-xl font-semibold">Post not found</h2>
      <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
        This post may have been removed or is not yet published.
      </p>
      <Link
        href="/blog"
        className="rounded-lg border px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80"
        style={{ borderColor: "var(--border)" }}
      >
        Back to blog
      </Link>
    </div>
  );
}
