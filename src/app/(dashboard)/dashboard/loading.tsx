import { DashboardFrame } from "./_components/dashboard-frame";
import {
  SessionFieldsFallback,
  SessionGreetingFallback,
} from "./_components/session-summary";

/**
 * The client-navigation counterpart of the prerendered shell.
 *
 * `loading.tsx` is the fallback for the whole segment, so it is what a soft
 * navigation into `/dashboard` paints while the RSC payload streams. It renders
 * the same frame the shell contains and the same fallbacks the page's own
 * boundaries use, so arriving by link and arriving by URL look identical — and
 * the parts of the page that never depended on the request are on screen either
 * way.
 *
 * It used to be a heading-shaped grey box above a generic card skeleton, which
 * meant a navigation to `/dashboard` blanked out content that was already known
 * at build time.
 */
export default function DashboardLoading() {
  return (
    <DashboardFrame
      greeting={<SessionGreetingFallback />}
      fields={<SessionFieldsFallback />}
    />
  );
}
