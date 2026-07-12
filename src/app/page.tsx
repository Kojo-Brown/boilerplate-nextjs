import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold tracking-tight">Next.js Boilerplate</h1>
      <p className="max-w-md text-center text-muted-foreground">
        Next.js 16 · App Router · TypeScript 6 · TailwindCSS 4 · Prisma 7 · NextAuth v5
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
      </div>
    </main>
  );
}
