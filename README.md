# boilerplate-nextjs

> Next.js 16 · App Router · TypeScript 6 · TailwindCSS 4 · Prisma 7 · NextAuth v5

Full-stack Next.js starter with server components, server actions, auth, and database wired up.

## Stack

| Layer         | Tech                  | Version |
| ------------- | --------------------- | ------- |
| Framework     | Next.js (App Router)  | 16.2    |
| Language      | TypeScript            | 6.0     |
| Styles        | TailwindCSS           | 4.3     |
| Database      | PostgreSQL via Prisma | 7.8     |
| Auth          | NextAuth.js           | v5      |
| Client state  | TanStack Query        | 5.101   |
| Notifications | Sonner                | 2.0     |

## Requirements

Node **22.12+** or **24** (`engines.node` is `^22.12.0 || ^24.0.0`), and pnpm 10.
CI runs lint, typecheck, tests, and the production build on both majors — if you
add or drop a major, change `engines.node` and the matrix in
`.github/workflows/ci.yml` together.

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
export async function createPost(data: {
  title: string;
}): Promise<ActionResult<Post>> {
  try {
    const post = await prisma.post.create({
      data: { ...data, authorId: session.user.id },
    });
    return ok(post);
  } catch {
    return err("Failed to create post");
  }
}
```

## CI

Every gate is warning-fatal — a warning fails the job rather than scrolling past:

| Gate                                | How warnings fail it               |
| ----------------------------------- | ---------------------------------- |
| `pnpm install`                      | `--strict-peer-dependencies`       |
| `pnpm lint`                         | `eslint --max-warnings 0`          |
| `pnpm typecheck` / `test` / `build` | `pnpm run strict <cmd>`            |
| all jobs                            | `NODE_OPTIONS=--throw-deprecation` |

`pnpm run strict <cmd>` wraps a command with `scripts/fail-on-warnings.ts`,
which mirrors the output, then exits non-zero if it contained a Next.js `⚠`,
a Vitest `DEPRECATED` banner, a Node process warning, or a package-manager
`WARN`. Tools like `next build` and `vitest run` print these and still exit 0.

Run it locally the same way CI does:

```bash
pnpm run strict pnpm build
```

Require the aggregate **CI** check in branch protection, not the individual
matrix legs — their names change whenever a Node major is added or dropped.

## Spec Progress

See [SPEC.md](./SPEC.md).
