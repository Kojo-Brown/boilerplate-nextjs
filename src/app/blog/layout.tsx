import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: { default: "Blog", template: "%s | Blog" },
  description: "Public blog powered by Incremental Static Regeneration",
};

export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--background)", color: "var(--foreground)" }}>
      <header className="border-b" style={{ borderColor: "var(--border)" }}>
        <div className="mx-auto max-w-3xl px-4 py-4">
          <nav className="flex items-center gap-6">
            <Link
              href="/blog"
              className="text-lg font-semibold tracking-tight hover:opacity-80 transition-opacity"
            >
              Blog
            </Link>
            <Link
              href="/"
              className="text-sm"
              style={{ color: "var(--muted-foreground)" }}
            >
              ← Home
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">{children}</main>
    </div>
  );
}
