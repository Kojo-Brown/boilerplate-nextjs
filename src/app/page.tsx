import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";

export default function HomePage() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      {/*
        The landing page renders directly under the root layout — there is no
        shell between them — so the toggle is mounted here rather than inherited.
        This is the application's front door; a visitor who arrives in the wrong
        theme should not have to navigate into `/blog` to fix it.
      */}
      <ThemeToggle className="absolute top-4 right-4" />
      <h1 className="text-4xl font-bold tracking-tight">Next.js Boilerplate</h1>
      <p className="max-w-md text-center text-muted-foreground">
        Next.js 16 · App Router · TypeScript 6 · TailwindCSS 4 · Prisma 7 ·
        NextAuth v5
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <Link
          href="/login"
          className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground"
        >
          Sign In
        </Link>
        <Link
          href="/dashboard"
          className="rounded-lg border px-5 py-2.5 text-sm font-medium"
        >
          Dashboard
        </Link>
        <Link
          href="/blog"
          className="rounded-lg border px-5 py-2.5 text-sm font-medium"
        >
          Blog (ISR)
        </Link>
        <Link
          href="/photos"
          className="rounded-lg border px-5 py-2.5 text-sm font-medium"
        >
          Photos (intercepting routes)
        </Link>
      </div>
    </main>
  );
}
