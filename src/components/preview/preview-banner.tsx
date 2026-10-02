import { exitPreviewAction } from "@/actions/preview";
import { getPreviewScope, isPreviewEnabled } from "@/lib/preview/draft";

/**
 * The band across the top of every page being served as a draft.
 *
 * A preview session is a cookie, and a cookie is invisible. Without a banner
 * the failure mode is not subtle-but-harmless — it is an author who opened a
 * preview an hour ago, forgot, and is now reading unpublished content while
 * believing they are looking at the live site. Every CMS integration worth the
 * name shows this, and it is the reason draft mode is worth having a component
 * for at all rather than just a route.
 *
 * A Server Component: the decision is made on the server, where the cookie is,
 * and the markup ships already rendered. It reads `isPreviewEnabled()`, which
 * is safe in a statically prerendered route — see `@/lib/preview/draft` for why
 * that is true of `draftMode()` and of nothing else request-scoped.
 *
 * ## It renders on the session, not on the scope
 *
 * `isPreviewEnabled()` and not `getPreviewScope()`, which is the opposite of
 * what the data layer does and deliberately so. A draft session whose scope
 * cookie is missing or unreadable reads the published site — that is the fix for
 * A01's last gap — and if this component keyed on the same answer, such a reader
 * would be in draft mode with no banner and therefore no way out of it. So the
 * banner appears whenever the framework says the request is a draft, and the
 * sentence inside it is what changes: there is no honest version of "you are
 * seeing unpublished content" to show someone who is not.
 *
 * Exiting is a plain `<form>` posting to a Server Action rather than a button
 * with a click handler. It costs nothing, needs no `"use client"`, and works
 * before hydration — which for the control that gets you *out* of a mode you
 * did not realise you were in is the whole point.
 */
export async function PreviewBanner({
  /**
   * Where "Exit preview" lands. Passed in rather than read from
   * `headers()`/`usePathname()`: reading the current path on the server is a
   * tracked dynamic access, and doing it here would drag `/blog` out of the
   * static prerender that `scripts/assert-route-shape.ts` requires it to keep.
   */
  returnTo,
}: {
  returnTo: string;
}) {
  if (!(await isPreviewEnabled())) return null;

  // Null when the scope cookie is absent, truncated or edited. The session is
  // real either way; what it can read is not.
  const scope = await getPreviewScope();

  return (
    <div
      // `role="status"` rather than `alert`: this is an ambient condition of
      // the page, not an interruption, and a screen reader announcing it
      // assertively on every navigation within the preview would be worse than
      // not announcing it at all.
      role="status"
      data-testid="preview-banner"
      className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm"
      style={{
        borderColor: "oklch(70% 0.15 75)",
        backgroundColor: "oklch(96% 0.05 90)",
        color: "oklch(35% 0.08 60)",
      }}
    >
      <p className="flex items-center gap-2">
        <span
          className="inline-block size-2 shrink-0 rounded-full"
          style={{ backgroundColor: "oklch(70% 0.17 60)" }}
          aria-hidden="true"
        />
        <span>
          {scope ? (
            <>
              <strong className="font-semibold">Draft mode.</strong> You are
              seeing this workspace&rsquo;s unpublished content, served fresh on
              every request. Readers without a preview link see the published
              site.
            </>
          ) : (
            <>
              <strong className="font-semibold">Draft mode, unscoped.</strong>{" "}
              This preview session names no workspace, so you are seeing the
              published site. Open a new preview link from the dashboard.
            </>
          )}
        </span>
      </p>

      <form action={exitPreviewAction} className="shrink-0">
        <input type="hidden" name="returnTo" value={returnTo} />
        <button
          type="submit"
          className="rounded-md border px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-80"
          style={{ borderColor: "oklch(70% 0.15 75)" }}
        >
          Exit preview
        </button>
      </form>
    </div>
  );
}
