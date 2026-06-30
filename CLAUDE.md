# boilerplate-nextjs — Agent Instructions

## What this repo is
Production-grade Next.js 16 App Router boilerplate with full-stack patterns. Spec-driven.

## Your job (scheduled agent)
1. Read `SPEC.md` — find the first `- [ ]` item
2. Implement it completely using App Router conventions
3. `pnpm typecheck && pnpm lint && pnpm test` before committing
4. `git add -A && git commit -m "feat: <feature>" && git push origin main`
5. Mark done in SPEC.md and push; update PROGRESS.md

## Versions (do not change)
- Next.js 16.2.9 | React 19.2.7 | TypeScript 6.0.3 | TailwindCSS 4.3.2
- Prisma 7.8.0 | NextAuth v5 | TanStack Query 5.101.2

## App Router Conventions
- `app/(auth)/` — unauthenticated pages (login, register)
- `app/(dashboard)/` — protected pages (check session in layout)
- `loading.tsx` — streaming skeleton for every route segment
- `error.tsx` — error boundary for every route segment
- Server Components by default; add `"use client"` only when needed
- Server Actions in `src/actions/` with `ActionResult<T>` return type from `@/lib/actions`
- Prisma accessed via `@/lib/prisma` singleton — never `new PrismaClient()`
- Typed routes enabled — use `href` type from `next/navigation`
