import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";

export const metadata: Metadata = {
  title: { default: "Photos", template: "%s | Photos" },
  description: "Public photo gallery demonstrating intercepting routes",
};

/**
 * Public chrome, mirroring `app/blog/layout.tsx`.
 *
 * Deliberately synchronous and session-free. A `cookies()`/`auth()` read here
 * would be inherited by `/photos` and `/photos/[id]` and push both out of the
 * prerender manifest — the exact regression `scripts/assert-route-shape.ts`
 * exists to catch, and the one that silently made every route in this app
 * dynamic for weeks.
 */
export default function PhotosLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className="min-h-screen"
      style={{
        backgroundColor: "var(--background)",
        color: "var(--foreground)",
      }}
    >
      <header className="border-b" style={{ borderColor: "var(--border)" }}>
        <div className="mx-auto max-w-4xl px-4 py-4">
          <nav className="flex items-center gap-6">
            <Link
              href="/photos"
              className="text-lg font-semibold tracking-tight transition-opacity hover:opacity-80"
            >
              Photos
            </Link>
            <Link
              href="/"
              className="text-sm"
              style={{ color: "var(--muted-foreground)" }}
            >
              ← Home
            </Link>
            <ThemeToggle className="ml-auto" />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-10">{children}</main>
    </div>
  );
}
