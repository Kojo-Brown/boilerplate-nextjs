"use client";

import { useCallback, useEffect, useState } from "react";
import { useReportWebVitals } from "next/web-vitals";
import { webVitalsMetricSchema } from "@/lib/vitals/metric";
import {
  VITALS_ENDPOINT,
  createBeaconTransport,
  createVitalsQueue,
} from "@/lib/vitals/queue";
import type { VitalsQueue, VitalsTransport } from "@/lib/vitals/queue";

/**
 * Renders nothing; reports every Web Vital the browser measures.
 *
 * Mounted once, in the root layout, which is the only place that works: the
 * hook has to be subscribed before the metrics it is waiting for are produced,
 * and LCP and TTFB are produced during the first paint. A reporter mounted
 * inside a route's own tree would miss the landing page's numbers on every
 * visit — and the landing page's numbers are the ones a Core Web Vitals report
 * is actually about.
 *
 * It is a client component, and it is the *only* client component the root
 * layout gains. That matters for what surrounds it: the layout reads no
 * cookies, every static route prerenders, and adding a `"use client"` island
 * does not change any of that — a client component is still server-rendered
 * into the shell. `scripts/assert-route-shape.ts` holds that line, and
 * `scripts/assert-vitals-wiring.ts` holds this component's place in the layout.
 *
 * ## Why the flush is on `visibilitychange`, not `unload`
 *
 * There is no event that reliably fires when a page is closed. `unload` and
 * `beforeunload` are not dispatched at all on mobile Safari — the browser
 * freezes and discards a backgrounded tab — and registering a handler for
 * either disqualifies the page from the back/forward cache, which makes the
 * navigation the visitor then measures slower. `visibilitychange` to `hidden`
 * is the last callback a page is guaranteed to get, and `pagehide` covers the
 * case where a tab is hidden and torn down in one step. Both are wired, and the
 * queue is empty after the first of them fires, so the second is a no-op.
 *
 * ## Why the path is read from `location`, and not from `usePathname`
 *
 * `usePathname` is the obvious choice and it is the wrong one *here*, for the
 * reason the root layout's own docblock gives about `auth()`: it is a
 * per-request read, and a per-request read in the root layout is inherited by
 * every route beneath it. Under Cache Components the build says so outright —
 *
 *   Route "/posts/[id]": Uncached data was accessed outside of <Suspense>.
 *
 * — naming this component. Wrapping it in a boundary would silence that while
 * still putting a dynamic hole in all fourteen routes, to obtain a string this
 * component never renders and only ever reads inside a callback that runs after
 * hydration. `location.pathname` is that same string, with no server read at
 * all, which is why the shells stayed static when this was added.
 *
 * It is read at *`add`* time, not at flush time — that part is load-bearing.
 * The flush happens as the page goes away, which in an SPA is frequently after
 * a client-side navigation has already changed the URL, so reading it then
 * attributes the metric to whichever page the visitor left for. Reading it when
 * the measurement arrives records where the measurement was taken, and the
 * queue flushes its outstanding batch itself when that value changes.
 */
export interface WebVitalsReporterProps {
  /**
   * Transport override, for tests and for a deployment that wants to keep its
   * metrics off this application's own endpoint.
   *
   * Deliberately a prop rather than a module-level singleton: a singleton would
   * be shared between the tests in a file and would make the beacon environment
   * a global that has to be restored between them.
   */
  transport?: VitalsTransport;
}

export function WebVitalsReporter({ transport }: WebVitalsReporterProps): null {
  // The queue outlives every render and must not be rebuilt by one: a new queue
  // would start empty, and the metrics buffered in the old one — which is every
  // metric measured before the first client-side navigation — would never be
  // sent. A lazy `useState` initialiser is the same shape `QueryProvider` uses
  // for its client, and unlike a ref assigned in render it is not a write
  // during render.
  const [queue] = useState<VitalsQueue>(() =>
    createVitalsQueue({
      transport: transport ?? createBeaconTransport(VITALS_ENDPOINT),
    }),
  );

  /**
   * The metric callback, and it has to be referentially stable.
   *
   * `useReportWebVitals` is `useEffect(() => { onCLS(fn); onLCP(fn); … },
   * [fn])`, and `web-vitals`'s `onX` functions return no teardown — so there is
   * nothing for the effect to clean up, and a new function identity does not
   * *replace* the previous subscription, it *adds* one. An inline closure would
   * therefore register a fresh set of six listeners on every render, and a
   * single layout shift would be reported once per render the page has ever
   * done. Depending only on `queue` (itself stable) is what keeps the
   * subscription to exactly one.
   */
  const report = useCallback(
    (metric: unknown) => {
      // Narrowed rather than cast. `next/web-vitals` types this argument as
      // `any` — its `Metric` comes from a bundled copy of `web-vitals` that
      // ships no declarations — so an annotation here would be a claim, not a
      // check. The schema is the same one the endpoint applies, which means a
      // shape the server would reject is dropped in the browser instead of
      // costing a request and a 422.
      const parsed = webVitalsMetricSchema.safeParse(metric);
      if (!parsed.success) return;

      // The pathname only. `location.href` would carry the query string, which
      // is where a real page keeps the search term, the share token and the
      // OAuth `code` — and this batch ends up in a log drain. The endpoint
      // rejects anything else anyway; not sending it is the first of the two.
      queue.add(window.location.pathname, parsed.data);
    },
    [queue],
  );

  useReportWebVitals(report);

  useEffect(() => {
    const flushIfHidden = (): void => {
      if (document.visibilityState === "hidden") queue.flush();
    };
    const flush = (): void => {
      queue.flush();
    };

    document.addEventListener("visibilitychange", flushIfHidden);
    // `pagehide` rather than `unload`: it fires for a page entering the
    // back/forward cache as well as one being destroyed, and unlike `unload` it
    // does not disqualify the page from that cache.
    window.addEventListener("pagehide", flush);

    return () => {
      document.removeEventListener("visibilitychange", flushIfHidden);
      window.removeEventListener("pagehide", flush);
      // Unmounting the reporter is unmounting the application, but a test — or
      // a future layout that renders this conditionally — would otherwise drop
      // whatever was buffered.
      queue.flush();
    };
  }, [queue]);

  return null;
}
