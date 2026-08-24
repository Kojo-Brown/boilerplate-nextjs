# boilerplate-nextjs — Agent Instructions

## What this repo is

Production-grade Next.js 16 App Router boilerplate with full-stack patterns. Spec-driven.

## Your job (scheduled agent, every 4h)

1. `git checkout main && git pull --ff-only origin main`
2. Read `SPEC.md`, take the **first** `- [ ]` item. Phase 0 items always win.
3. `git checkout -b <type>/<kebab-slug>` (`feat`/`fix`/`chore`/`ci`/`docs`)
4. Implement it completely using App Router conventions — plus tests and docs.
5. Run every gate locally; **all must pass** before pushing:
   ```
   pnpm install
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm build
   ```
6. Commit, `git push -u origin <branch>`, then `gh pr create`.
7. `gh pr checks --watch` → **merge only if every check is green**:
   `gh pr merge --squash --delete-branch`
8. Pull main, mark the item `- [x]` in `SPEC.md`, update `../PROGRESS.md`,
   push as a `chore:` commit.

If a check fails, fix forward on the same branch. Never merge red. Never weaken
a test to force green.

## Secrets

Never commit real credentials, tokens, keys, or `.env` files. `AUTH_SECRET` and
provider keys come from the environment. Anything reachable from a client
component is public — keep secrets behind `server-only`. Scan
`git diff --cached` before every push.

## Versions (do not change)

- Next.js 16.2.9 | React 19.2.7 | TypeScript 6.0.3 | TailwindCSS 4.3.2
- Prisma 7.8.0 | NextAuth v5 | TanStack Query 5.101.2

## App Router Conventions

- `app/(auth)/` — unauthenticated pages (login, register)
- `app/(dashboard)/` — protected pages. The gate is `PROTECTED_PREFIXES` /
  `ADMIN_PREFIXES` in `auth.config.ts`, plus a session read next to any data
  that is per-user. Never the layout: Next does not re-render a shared layout
  when navigating between sibling routes inside it. Never the page body either —
  a page that awaits the session cannot prerender anything below the await.
- `loading.tsx` — streaming skeleton for every route segment, rendering the same
  frame and fallbacks as the page itself. Put `<Suspense>` around each read
  rather than relying on `loading.tsx` alone; see `docs/streaming.md`.
- `error.tsx` — error boundary for every route segment
- Server Components by default; add `"use client"` only when needed
- Server Actions in `src/actions/` with `ActionResult<T>` return type from `@/lib/actions`
- Prisma accessed via `@/lib/prisma` singleton — never `new PrismaClient()`
- Typed routes enabled — use `href` type from `next/navigation`
