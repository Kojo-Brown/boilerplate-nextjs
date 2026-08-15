# Spec: boilerplate-nextjs

> Spec-driven. Mark `[x]` only after pushing.

## Phase 0 — Green Baseline (blocks all feature work)

- [x] Verify every dependency version actually exists on the registry and fix the ones that do not, then commit a lockfile — `next-auth@^5.0.0` was unsatisfiable (v5 is prerelease-only), `jsdom` and `@vitest/coverage-v8` were used but undeclared, and the `linux-musl-openssl-3.x.x` binary target does not exist (PR #18)
- [x] Get `install`, `typecheck`, `lint`, `test`, and `build` all passing locally from a clean clone — required a full Prisma 7 migration and an ESLint flat config, since there was no ESLint config at all and Next 16 removed `next lint` (PR #18)
- [x] Promote `workflow-templates/ci.yml` to `.github/workflows/ci.yml` and confirm it runs green on a PR — green on PR #18 with a Postgres service for the build job
- [x] Add a CI job matrix covering the supported Node version and fail the build on any warning — lint, typecheck, test, and build run on Node 22 and 24 with `fail-fast: false`; warnings fail via `--strict-peer-dependencies`, `--max-warnings 0`, `NODE_OPTIONS=--throw-deprecation`, and `pnpm run strict` (PR #20)

Phase 0 items 1-3 complete as of PR #18 (2026-07-30): install
(`--frozen-lockfile`, zero warnings), lint (0 errors, 0 warnings), format check
on changed files, typecheck, 223 unit tests across 28 files, and build all green
in CI on Node 22, with the build prerendering `/blog/[slug]` against a real
Postgres 16 service container.

**Phase 0 complete as of PR #20 (2026-08-01).** All eleven checks green on both
Node majors. Making warnings fatal forced two real fixes: `src/middleware.ts`
became `src/proxy.ts` (Next 16 renamed the file convention) and `vitest.config.ts`
moved off the deprecated `environmentMatchGlobs` onto named `dom`/`node`
projects. `pnpm run strict <cmd>` wraps commands that print warnings and still
exit 0; the build job now caches `.next/cache`.

Known gaps carried into Phase 1: Prettier has never run repo-wide (~79
pre-existing offenders, so `format:check` gates only changed files); Playwright
E2E is still not wired into CI; there is no migrations directory, so CI uses
`prisma db push`; `workflow-templates/ci.yml` still holds the stale
pre-promotion copy; and the warning gate carries one documented exemption for
Next's cold-cache notice, which describes the runner rather than the code.

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
- [x] Image upload with Next.js Server Actions + S3 presigned URLs

## Phase 5 — Performance

- [x] Route-level streaming with `loading.tsx` skeletons
- [x] `next/image` wrapper with blur placeholder + LQIP
- [x] Parallel routes for dashboard widgets
- [x] ISR (incremental static regen) example for public pages

## Phase 6 — Testing

- [x] Vitest + Testing Library for server/client components
- [x] Playwright E2E: auth flow, protected page, form submission
- [x] MSW for API route mocking in tests

## Phase 7 — DevOps

- [x] GitHub Actions: lint → typecheck → test → build
- [x] Dockerfile (standalone output mode)
- [x] Vercel config (`vercel.json`) + GitHub deploy action

## Phase 8 — Advanced App Router

- [ ] Partial Prerendering: static shell + streamed dynamic holes, with a documented tradeoff guide
- [ ] Intercepting routes for a modal photo/detail view with a shareable URL
- [ ] Route handlers as a typed edge API with runtime selection (`edge` vs `nodejs`) per route
- [ ] `unstable_cache` / `revalidateTag` tag-based invalidation strategy across mutations
- [ ] Draft mode for CMS preview with signed preview tokens
- [ ] Streaming with granular Suspense boundaries and per-segment `loading.tsx` skeletons
- [ ] `generateStaticParams` + on-demand ISR revalidation webhook

Partial Prerendering is enabled (`cacheComponents: true`) with the tradeoff
guide in [docs/partial-prerendering.md](./docs/partial-prerendering.md). Six
routes are fully static, six are a prerendered shell with streamed holes.

`experimental.ppr` no longer exists in Next 16 — it was merged into
`cacheComponents`, which is typed `boolean` and has **no incremental mode**, so
there is no per-route opt-in and all 14 routes had to comply at once.

Three items below are affected by the move, and the Phase 5 ISR items are
redefined by it: `revalidate`/`dynamicParams` are gone from both blog routes in
favour of `"use cache"` + `cacheLife`/`cacheTag` in `src/lib/cache/blog.ts`, and
`revalidatePath` is now `updateTag`.

Two defects were found and fixed on the way, both of which had been invisible:

- `src/app/layout.tsx` awaited `auth()`, which reads cookies and made **every**
  route dynamic. `/blog`'s `export const revalidate = 60` had never taken
  effect — the Phase 5 ISR items were written but not in force.
- `(dashboard)/layout.tsx` awaited the session in its body, so the "static
  shell" for `/posts` was 2,620 bytes containing a `<title>`. Its session read
  was also the only authorisation check on `/images` and `/upload`, which are
  absent from `PROTECTED_PREFIXES`; both now guard themselves.

`scripts/assert-route-shape.ts` asserts the route table and the shell contents
after every CI build, so neither defect can return quietly.

## Phase 9 — Server Actions & Data Integrity

- [ ] Server Action hardening: origin checks, auth assertion, and Zod input parsing on every action
- [ ] `useOptimistic` + `useActionState` end-to-end on a real mutation with rollback
- [ ] Idempotency keys for Server Actions to survive double-submit and retry
- [ ] Optimistic concurrency with a `version` column and a conflict-resolution UI
- [ ] Rate limiting Server Actions and route handlers at the edge
- [ ] Transactional writes with Prisma interactive transactions + an outbox row
- [ ] N+1 elimination in server components with batched Prisma queries

## Phase 10 — Performance

- [ ] Core Web Vitals instrumentation via `useReportWebVitals` shipped to an analytics sink
- [ ] Bundle budget gate in CI + per-route JS payload report
- [ ] `next/font` self-hosting with subsetting and zero layout shift
- [ ] Third-party script strategy audit with `next/script` and a facade pattern
- [ ] Edge middleware geo/AB routing with cookie-stable bucketing
- [ ] React Compiler enabled with a memo-removal audit

## Phase 11 — Security

- [ ] CSP with per-request nonces via middleware, `strict-dynamic`, no `unsafe-inline`
- [ ] Auth.js session hardening: rotation, reuse detection, and secure cookie flags
- [ ] Server-only secrets enforced by `server-only` imports and a lint rule
- [ ] OWASP Top 10 checklist with a test per mitigation
- [ ] Multi-tenancy with row-level security and a tenant-scoped Prisma client
- [ ] File-upload validation: content sniffing, size caps, and antivirus hook

## Phase 12 — Accessibility & TDD

- [ ] WCAG 2.2 AA audit with axe in CI, zero-violation gate
- [ ] Focus management across App Router navigations with route announcements
- [ ] i18n with `next-intl`: locale routing, plurals, and an RTL pass
- [ ] TDD kata: one Server Action built red→green→refactor, one commit per step
- [ ] Playwright a11y + visual regression suite on the critical journey
