import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";

export const metadata: Metadata = {
  title: { default: "Pricing", template: "%s | Pricing" },
  description: "Plans and pricing",
};

/**
 * Public chrome, mirroring `app/blog/layout.tsx` and `app/photos/layout.tsx`.
 *
 * Synchronous and session-free, for the reason those two say: a `cookies()` or
 * `auth()` read here is inherited by `/pricing` *and* by every
 * `/pricing/v/[variant]` beneath it, and would push all of them out of the
 * prerender manifest. That would be a particularly expensive mistake on this
 * subtree — the entire point of deciding the variant in the proxy is that the
 * pages it chooses between stay static.
 *
 * It is also the layout both arms share, which is what makes the experiment a
 * comparison: the header, the theme toggle and the width are identical, so the
 * only difference between the two documents is the one being tested.
 */
export default function PricingLayout({
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
        <div className="mx-auto max-w-5xl px-4 py-4">
          <nav className="flex items-center gap-6">
            <Link
              href="/pricing"
              className="text-lg font-semibold tracking-tight transition-opacity hover:opacity-80"
            >
              Pricing
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
      <main className="mx-auto max-w-5xl px-4 py-10">{children}</main>
    </div>
  );
}
