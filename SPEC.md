# Spec: boilerplate-nextjs

> Spec-driven. Mark `[x]` only after pushing.

## Phase 0 — Green Baseline (blocks all feature work)

- [x] Verify every dependency version actually exists on the registry and fix the ones that do not, then commit a lockfile — `next-auth@^5.0.0` was unsatisfiable (v5 is prerelease-only), `jsdom` and `@vitest/coverage-v8` were used but undeclared, and the `linux-musl-openssl-3.x.x` binary target does not exist (PR #18)
- [x] Get `install`, `typecheck`, `lint`, `test`, and `build` all passing locally from a clean clone — required a full Prisma 7 migration and an ESLint flat config, since there was no ESLint config at all and Next 16 removed `next lint` (PR #18)
- [x] Promote `workflow-templates/ci.yml` to `.github/workflows/ci.yml` and confirm it runs green on a PR — green on PR #18 with a Postgres service for the build job
- [x] Add a CI job matrix covering the supported Node version and fail the build on any warning — lint, typecheck, test, and build run on Node 22 and 24 with `fail-fast: false`; warnings fail via `--strict-peer-dependencies`, `--max-warnings 0`, `NODE_OPTIONS=--throw-deprecation`, and `pnpm run strict` (PR #20)
- [x] Compile TailwindCSS: there is no `postcss.config.*`, so `@tailwindcss/postcss` never runs and the application ships **unstyled** — `postcss.config.mjs` added; the bundle goes 1,103 → 34,240 bytes. With Tailwind actually running, three `@utility` rules turned out to have been reaching for something they could not express (`@utility primary` defines `.primary`, not `bg-primary`), so `bg-primary`, `text-primary-foreground`, `text-muted-foreground`, `bg-muted`/`hover:bg-muted` and `ring-border` still compiled to nothing across the landing page, both auth forms, the toast demo and the avatar; an `@theme inline` block publishing the existing tokens into Tailwind's `--color-*` namespace replaces them, verified in a browser to follow the `.dark` override. `scripts/assert-css-output.ts` now reads the built stylesheet in CI — checked against the failure it names by moving the config aside and rebuilding: `next build` exited 0, the gate exited 1 with 13 violations. The `/photos` grid measures three columns at 1280px, two at 700px, one at 500px, at a 3/2 aspect ratio; all 7 `e2e/photos.spec.ts` cases pass and the `shellMustContain` assertions were unaffected (PR #23)

**Phase 0 reopened (2026-08-17, found while building `/photos` in PR #22).**
The production CSS bundle is 1,103 bytes — the `:root` custom properties from
`globals.css` and nothing else. Not one Tailwind utility reaches the browser:
`.flex`, `.absolute`, `.grid-cols-3` and `aspect-ratio` are all absent, so
every page in the application renders as unstyled block flow. `next build` is
green, every unit test passes, and the route-shape gate is satisfied, because
none of them look at the stylesheet.

The cause is that `@tailwindcss/postcss` is in `devDependencies` but is never
wired up — the repository has no `postcss.config.mjs`, so Next hands
`@import "tailwindcss"` to Lightning CSS, which resolves it and drops the
directives it does not understand.

Verified during PR #22: adding

```js
// postcss.config.mjs
const config = { plugins: { "@tailwindcss/postcss": {} } };
export default config;
```

takes the bundle from 1,103 bytes to 33,686, and the `/photos` grid goes from
three zero-height boxes with viewport-filling images to a correct three-column
layout. It was left out of that PR because it restyles all 14 routes and is a
separate change from the routing item; it belongs here, ahead of feature work.
Re-check the `shellMustContain` assertions in `scripts/assert-route-shape.ts`
when landing it, and re-run `e2e/photos.spec.ts` — all seven cases pass against
a Tailwind-compiled build and cannot pass without one.

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

**Phase 0 closed again as of PR #23 (2026-08-17).** Twelve checks green on both
Node majors. The reopened item is fixed and, more to the point, is now checked:
`scripts/assert-css-output.ts` reads the stylesheet the build wrote, so the
class of failure that produced a green build and an unstyled application cannot
recur silently. That gate was itself verified against the failure it names
rather than only against a passing build.

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
- [x] Style the blog post body: `app/blog/[slug]/page.tsx` applies `prose prose-neutral`, but `@tailwindcss/typography` is not a dependency, so both classes compile to nothing and the post body renders with default paragraph spacing. Found while landing PR #23 and left out of it deliberately — adding a plugin is a dependency decision, not part of getting Tailwind to run. It is the one place the application is still knowingly unstyled. — plugin loaded at 0.5.20; `prose-neutral` replaced by `@utility prose-app`, which re-points every `--tw-prose-*` variable at the design tokens, because the plugin's fixed palettes are not `--foreground` and `dark:prose-invert` would have followed the OS rather than the theme toggle. `toParagraphs` splits the plain-text `Post.content` on blank lines, since prose's paragraph rhythm had one `<p>` and nothing to space. `.prose-app` outranks `.prose` only by emission order — same layer, same specificity — so the CSS gate now asserts that ordering alongside both classes. Measured in Chromium in both themes: 20px prose margin, 28px line-height, body colour equal to the computed `--foreground` under `.dark` as well as `:root` (PR #24)
- [x] Make the `dark:` variant track the theme toggle: `next-themes` is configured with `attribute="class"` and toggles `.dark` on `<html>`, but Tailwind v4's built-in `dark:` variant resolves to `@media (prefers-color-scheme: dark)` and this project never overrides it. So every `dark:` utility in the codebase — `dark:hover:bg-green-950` in `toast-demo`, `dark:bg-red-950/20` in `image-upload`, the published/draft badges in `post-card` and `posts-manager` — follows the operating system and ignores the toggle, in both directions: switching to dark leaves them light, and a dark-mode OS lights them up on a page the user has set to light. Declaring `@custom-variant dark (&:where(.dark, .dark *))` in `globals.css` is the fix, but it changes rendering everywhere those classes appear, so each needs looking at rather than a blanket flip. Found while landing the prose item above, which sidestepped the variant entirely by reading tokens through `var()`. — `@custom-variant dark (&:where(.dark, .dark *))` in `globals.css`. `:where()` rather than the shorter `.dark &` because specificity is load-bearing: `.dark &` compiles to (0,2,0), which beats the `bg-green-100` it is meant to override and beats unrelated single-class rules that should have won, while `:where()` contributes nothing and leaves the rule level with its light counterpart, settled on emission order like every other variant — verified on the built stylesheet, where all five pairs emit the dark rule after the light one. All eleven `dark:` declarations across the four components were written for a class toggle and needed no rewriting; each was measured rather than assumed, in Chromium across all four combinations of OS preference × html class, on two claims apiece (the value under `.dark` differs from the value without it, and for a fixed class the OS makes no difference): 11/11 pass, and 11/11 failed the identical probe before. The case reachable today, dark-mode OS with `theme=light` persisted, went from a white page carrying a `green-900/30` badge to a `green-100` one. System preference is not lost — `enableSystem` has `next-themes` read `prefers-color-scheme` itself and toggle the same class. `next build` exited 0 both before and after, so `REQUIRED_CLASS_KEYED_DARK` now reads the _condition_ each rule is emitted under: losing the one line leaves every utility still emitted at the same byte count, invisible to the required-utility list and the size floor alike. Checked against the regression it names — line removed and rebuilt, `next build` exited 0 and the gate exited 1 with 8 violations naming the media query (PR #25)
- [x] Mount the theme control: `ThemeToggle` (`src/components/ui/theme-toggle.tsx`) cycles system → light → dark through `next-themes` and has eight passing tests, and nothing in the application renders it — `grep -r ThemeToggle src` returns the component and its own test and nothing else. So the dark theme is currently unreachable by a user: the only inputs are the OS preference and a `localStorage.theme` value no UI writes. Found while landing the `dark:` variant item above, which the missing mount does not block — the variant is what makes `dark:` utilities follow the resolved theme however it was resolved — but which it does leave undemonstrable in the running app. The toggle needs a home in `app-shell.tsx` alongside `NavLinks`/`MobileDrawer`, reachable on both the public and dashboard shells, plus the hydration care a theme control needs: `theme` is `undefined` on the server, so a naive render mismatches. — mounted in all five shells: `app-shell.tsx` (the five dashboard routes), `blog/layout.tsx`, `photos/layout.tsx`, `(auth)/layout.tsx` and `page.tsx`. The last two are the ones the item's "public shells" phrasing does not cover, and they are the ones that matter most for reachability — `/` renders directly under the root layout and inherits no shell at all, and `/login`/`/register` are where a signed-out visitor arrives; neither has header chrome, so the control is pinned to the corner rather than left out. In `app-shell.tsx` it sits ahead of `headerSlot`, not after it: `headerSlot` is a streamed hole (`<UserChip>` behind Suspense), so the other order would slide the control sideways when the session resolved. The hydration care turned out to be the substantive half. `next-themes` seeds from `localStorage` in a lazy `useState` initialiser, so the first _client_ render already knows the theme while the server never can, and `suppressHydrationWarning` on `<html>` does not reach it — that covers the element's own attributes, which is what the provider's inline script rewrites, not descendants. The button therefore renders a neutral label and half-disc icon until `useIsHydrated()` flips (`false` on the server _and_ on the hydrating render, `true` from the commit on, so the two agree by construction — the same hook `MobileDrawer` already uses, which also keeps it clear of `react-hooks/set-state-in-effect`). Deliberately not `disabled`: nothing here is interactive pre-hydration, so singling this control out would only flash `disabled:opacity-50` on every load. `src/app/theme-control.test.tsx` asserts each of the five shells mounts it — that guard is the point of the item, since a component's own tests render it themselves and can never catch its absence from the application, which is exactly how this survived eight green tests for weeks. Verified beyond jsdom: `aria-label="Theme"` appears in the prerendered HTML of all five shells including the PPR dashboard ones, route shape is unchanged (14 expectations, the six static routes still static), and Chromium against `pnpm start` confirms the cycle, `.dark` landing on `<html>`, the paint changing, and persistence across `/` → `/blog`. 403 unit tests, up from 393; `e2e/theme.spec.ts` adds five browser cases but the e2e suite is still not wired into CI, so it did not gate the merge (PR #26)

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

- [x] Partial Prerendering: static shell + streamed dynamic holes, with a documented tradeoff guide — enabled via `cacheComponents` (there is no `experimental.ppr` in Next 16 and no incremental mode); found and fixed two invisible defects on the way, the root layout's `auth()` making every route dynamic and the dashboard layout's session read reducing its "static shell" to a `<title>` (PR #21)
- [x] Intercepting routes for a modal photo/detail view with a shareable URL — `@modal/(.)photos/[id]` renders a dialog on a soft navigation, `photos/[id]` renders a full page on a hard one; closing the modal is `router.back()`, not local state. Verified in a real browser (7/7 in `e2e/photos.spec.ts`), which is where the missing Tailwind build was found (PR #22)
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
