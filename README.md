# boilerplate-nextjs

> Next.js 16 · App Router · TypeScript 6 · TailwindCSS 4 · Prisma 7 · NextAuth v5

Full-stack Next.js starter with server components, server actions, auth, and database wired up.

## Stack

| Layer | Tech | Version |
|-------|------|---------|
| Framework | Next.js (App Router) | 16.2 |
| Language | TypeScript | 6.0 |
| Styles | TailwindCSS | 4.3 |
| Database | PostgreSQL via Prisma | 7.8 |
| Auth | NextAuth.js | v5 |
| Client state | TanStack Query | 5.101 |
| Notifications | Sonner | 2.0 |

## Quick Start

```bash
git clone https://github.com/Kojo-Brown/boilerplate-nextjs.git
cd boilerplate-nextjs
pnpm install

cp .env.example .env  # fill in DATABASE_URL, NEXTAUTH_SECRET

pnpm db:generate && pnpm db:migrate
pnpm dev  # http://localhost:3000
```

## Project Structure

```
src/
├── app/
│   ├── (auth)/          # Login, register pages
│   ├── (dashboard)/     # Protected pages
│   ├── layout.tsx       # Root layout
│   └── page.tsx         # Home page
├── actions/             # Server Actions
├── components/
│   ├── layout/          # Nav, Sidebar, Footer
│   └── ui/              # Design system primitives
├── hooks/               # Client hooks
├── lib/
│   ├── actions.ts       # ActionResult<T> helpers
│   ├── env.ts           # Zod-validated env vars
│   └── prisma.ts        # Prisma singleton
├── styles/
│   └── globals.css      # TailwindCSS + design tokens
└── types/               # Shared types
prisma/
├── schema.prisma        # User, Account, Session, Post
└── seed.ts
```

## Patterns

**Server Action:**
```ts
"use server";
import { ok, err } from "@/lib/actions";
export async function createPost(data: { title: string }): Promise<ActionResult<Post>> {
  try {
    const post = await prisma.post.create({ data: { ...data, authorId: session.user.id } });
    return ok(post);
  } catch {
    return err("Failed to create post");
  }
}
```

## Spec Progress
See [SPEC.md](./SPEC.md).
