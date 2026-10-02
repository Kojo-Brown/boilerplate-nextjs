/**
 * Reading whether the current request is a preview.
 *
 * One function, and it exists for the paragraph below rather than for the line
 * of code.
 *
 * ## Why this can be called from a static route
 *
 * `/blog` is prerendered static and `/blog/[slug]` is prebuilt from
 * `generateStaticParams`; `scripts/assert-route-shape.ts` fails CI if either
 * stops being so. Every other request-scoped read in Next — `cookies()`,
 * `headers()`, `searchParams` — would end that the moment it appeared in a page
 * body, because each is *tracked* as a dynamic access and pushes the route out
 * of the prerender.
 *
 * Reading `draftMode().isEnabled` is not. In Next 16.2.9 the tracking lives on
 * `enable()` and `disable()` — the mutations — and not on the getter
 * (`next/dist/server/request/draft-mode.js`). During a prerender the work unit
 * store is of type `prerender`, `draftMode()` resolves to a null provider, and
 * `isEnabled` is a plain `false`. So the shell builds exactly as it did before,
 * with the published branch baked in.
 *
 * That asymmetry is the whole reason this feature can exist alongside the
 * Partial Prerendering work without a Suspense boundary or a route-shape
 * regression, and it is not something a reader would assume. Hence a named
 * function with this comment attached, rather than `(await draftMode())
 * .isEnabled` spelled at three call sites where the next person to add a
 * fourth has nothing to read.
 *
 * ## And why the cached reads do not need to be told
 *
 * When the bypass cookie is present Next sets `workStore.isDraftMode`, which
 * makes `shouldForceRevalidate()` true for every `"use cache"` entry in the
 * request and suppresses saving the result
 * (`next/dist/server/use-cache/use-cache-wrapper.js`). The full route cache is
 * skipped for the same reason. Verified against a production build rather than
 * assumed: two draft requests to `/blog` two seconds apart returned render
 * stamps two seconds apart, while two public requests returned the same stamp.
 *
 * `@/lib/cache/blog` still branches *outside* its `"use cache"` functions. Not
 * because the framework would cache a draft — it demonstrably will not — but
 * because "a draft response can never become a cache entry" should be a
 * property of the shape of the code, not of a framework internal that a future
 * release is free to change.
 *
 * ## Two functions, because draft mode is two questions
 *
 * `isPreviewEnabled` answers "is this reader in a draft session"; it is one
 * boolean the framework owns and it is all the banner needs.
 * `getPreviewScope` answers "whose drafts may they see", which the framework
 * knows nothing about — it comes out of the signed cookie `/api/preview` writes
 * alongside the bypass cookie, and it is what every preview *read* takes. They
 * were one function until a preview acquired a tenant, and keeping them one
 * would have meant the banner disappearing in exactly the case a reader most
 * needs it. See `getPreviewScope` for which way each one fails.
 */
import { cookies, draftMode } from "next/headers";
import { PREVIEW_SCOPE_COOKIE, verifyPreviewScope } from "@/lib/preview/scope";
import type { PreviewScope } from "@/lib/preview/scope";

/**
 * Whether this request is being served in draft mode.
 *
 * Always `false` at build time, which is what makes it safe in a static route.
 *
 * This is the *session* and not the entitlement: it says a reader is in draft
 * mode, not what they may read. `getPreviewScope` below is what the data layer
 * asks. The only caller of this one is `@/components/preview/preview-banner`,
 * and the split is deliberate — see that component.
 */
export async function isPreviewEnabled(): Promise<boolean> {
  return (await draftMode()).isEnabled;
}

/**
 * The workspace this request may read drafts from, or `null`.
 *
 * ## Why the cookie read is below the draft-mode check
 *
 * Not tidiness — it is the whole reason this function can be called from
 * `/blog`, and it is the one thing a reader must not reorder. `cookies()` is a
 * tracked dynamic access: calling it in a statically prerendered route's graph
 * ends the prerender, and `scripts/assert-route-shape.ts` fails CI when `/blog`
 * or `/blog/[slug]` stop being static. `draftMode().isEnabled` is not tracked
 * (see this module's header), and during a prerender it is a plain `false` — so
 * the early return is taken at build time and the cookie jar is never touched.
 * At request time, a reader who *is* in draft mode is already being served
 * dynamically, because the bypass cookie skips the full route cache, so the read
 * costs nothing that was not already spent.
 *
 * Measured rather than argued: with this in their graph, `pnpm build` still
 * lists `/blog` as `○` (static) and `/blog/[slug]` as `◐` (partial prerender),
 * which is the shape that gate requires.
 *
 * ## Why a missing or forged cookie is `null` rather than "every tenant"
 *
 * Because "every tenant" is the gap this closes. A draft session whose scope
 * cookie is absent, truncated or edited is answered with the published site —
 * the reads fall back to `getCachedPublishedPosts` and `getCachedPost` like any
 * anonymous visitor's — and the database agrees independently: with no tenant in
 * `app.preview_tenant_id`, `posts_preview_read` matches no row at all.
 *
 * The banner is deliberately *not* keyed on this. A reader whose scope cookie
 * went missing would otherwise be in draft mode with no banner and therefore no
 * "Exit preview" button, which is a mode you cannot leave. So the data fails
 * closed and the escape hatch fails open.
 */
export async function getPreviewScope(): Promise<PreviewScope | null> {
  if (!(await draftMode()).isEnabled) return null;

  const cookie = (await cookies()).get(PREVIEW_SCOPE_COOKIE)?.value;
  if (!cookie) return null;

  return verifyPreviewScope(cookie);
}
