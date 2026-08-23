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
 */
import { draftMode } from "next/headers";

/**
 * Whether this request is being served in draft mode.
 *
 * Always `false` at build time, which is what makes it safe in a static route.
 */
export async function isPreviewEnabled(): Promise<boolean> {
  return (await draftMode()).isEnabled;
}
