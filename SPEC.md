# Spec: boilerplate-nextjs

> Spec-driven. Mark `[x]` only after pushing.

## Phase 1 — Foundation
- [x] Next.js 16 App Router + TypeScript 6 + TailwindCSS 4 scaffold
- [x] Prisma 7 + PostgreSQL schema (User, Session, Post) with seed
- [x] Zod-validated env vars (`src/lib/env.ts`)
- [x] Server Actions pattern with typed responses (`ActionResult<T>`)
- [x] Route groups: `(auth)` for login/register, `(dashboard)` for protected

## Phase 2 — Auth
- [x] NextAuth.js v5 (credentials + Google provider) with Prisma adapter
- [x] Middleware for protected routes (redirect to /login)
- [x] Session-aware server components via `auth()` helper
- [x] Role-based access: admin guard via middleware matcher

## Phase 3 — UI System
- [x] shadcn/ui-compatible component primitives (Button, Input, Card, Dialog)
- [x] Dark mode via `next-themes` with CSS variables
- [x] Toast notifications (Sonner)
- [x] Responsive nav layout with mobile drawer

## Phase 4 — Data Layer
- [x] Server components with Prisma direct queries (no API layer)
- [x] TanStack Query for client-side mutations + optimistic updates
- [x] Cursor-based pagination helper
- [ ] Image upload with Next.js Server Actions + S3 presigned URLs

## Phase 5 — Performance
- [ ] Route-level streaming with `loading.tsx` skeletons
- [ ] `next/image` wrapper with blur placeholder + LQIP
- [ ] Parallel routes for dashboard widgets
- [ ] ISR (incremental static regen) example for public pages

## Phase 6 — Testing
- [ ] Vitest + Testing Library for server/client components
- [ ] Playwright E2E: auth flow, protected page, form submission
- [ ] MSW for API route mocking in tests

## Phase 7 — DevOps
- [ ] GitHub Actions: lint → typecheck → test → build
- [ ] Dockerfile (standalone output mode)
- [ ] Vercel config (`vercel.json`) + GitHub deploy action
