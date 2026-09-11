/**
 * The client-side buffer between `useReportWebVitals` and the network.
 *
 * `useReportWebVitals` fires its callback once per measurement, and several of
 * those measurements are revised as the page lives: CLS grows with every layout
 * shift, and INP is re-reported whenever a slower interaction displaces the one
 * before it. Posting on every call would mean eight-or-more requests per page
 * view, each one a request the rate limiter has to count and the sink has to
 * store, and the early ones are superseded before the visitor has finished
 * reading. Buffering and sending once is not an optimisation here — it is the
 * only way the numbers that arrive are the final ones.
 *
 * Three things follow from that, and they are what this module is:
 *
 *  1. **A revision replaces its predecessor.** `web-vitals` mints one id per
 *     metric per page load and reuses it across re-reports, so the id is the
 *     identity and the last report under it wins. A queue that appended would
 *     send LCP three times and leave the sink to work out which was final.
 *  2. **A navigation is a boundary.** This is an SPA: a route change does not
 *     reload the page, so the same reporter keeps feeding the same queue with
 *     metrics that belong to a different URL. Handing the whole batch to
 *     whatever path happened to be current at flush time would attribute the
 *     landing page's LCP to the page the visitor navigated to next. `add`
 *     therefore flushes the outstanding batch before it accepts a metric for a
 *     new path.
 *  3. **The flush must survive the page.** The moment worth sending at is the
 *     moment the document goes away, which is also the moment an ordinary
 *     `fetch` is cancelled. `createBeaconTransport` is where that is handled.
 *
 * The queue itself holds no DOM reference and no timer: it is a value with a
 * transport injected, so the tests describe a navigation or an overflow
 * directly instead of driving a browser to produce one.
 */
import { MAX_BATCH_SIZE } from "./metric";
import type { VitalsPayload, WebVitalsMetric } from "./metric";

/** Sends one batch. Fire-and-forget by contract — see `createBeaconTransport`. */
export type VitalsTransport = (payload: VitalsPayload) => void;

export interface VitalsQueue {
  /** Buffers a metric measured on `path`, flushing first if the path changed. */
  add: (path: string, metric: WebVitalsMetric) => void;
  /** Sends whatever is buffered. A no-op when nothing is. */
  flush: () => void;
  /** The buffered metrics, for tests and for the reporter's own assertions. */
  pending: () => readonly WebVitalsMetric[];
}

export interface VitalsQueueOptions {
  transport: VitalsTransport;
  /**
   * Flush automatically once this many metrics are buffered.
   *
   * Defaults to the payload schema's own ceiling, so the queue cannot build a
   * batch the endpoint would reject as too large. A page that outlives its
   * budget — a long-lived dashboard accumulating INP revisions under new ids —
   * sends two batches rather than one oversized one that 422s and is lost.
   */
  maxBatchSize?: number;
}

export function createVitalsQueue({
  transport,
  maxBatchSize = MAX_BATCH_SIZE,
}: VitalsQueueOptions): VitalsQueue {
  // Insertion-ordered by id, which is what makes "replace the revision, keep
  // the position" a single `set` rather than an index search.
  let buffered = new Map<string, WebVitalsMetric>();
  let currentPath: string | null = null;

  function flush(): void {
    // An empty beacon is still a request: it is counted by the limiter, logged
    // by the proxy, and rejected by the payload schema, which requires at least
    // one metric. Every listener in the reporter can fire on a page that
    // produced nothing, so this is the common case rather than the edge one.
    if (buffered.size === 0) return;
    if (currentPath === null) return;

    const payload: VitalsPayload = {
      path: currentPath,
      metrics: [...buffered.values()],
    };

    // Cleared *before* the send, not after. A transport that throws — a
    // `sendBeacon` on a document the browser has already torn down, an
    // extension that has replaced `fetch` — would otherwise leave the batch
    // buffered for the next flush to retry, and the next flush is on a page
    // that is going away too. Telemetry is not worth an exception on the
    // unload path.
    buffered = new Map();

    transport(payload);
  }

  return {
    add(path, metric) {
      // The navigation boundary. Reading `currentPath` before the write is what
      // sends the outstanding metrics under the path they were measured on.
      if (currentPath !== null && currentPath !== path) flush();
      currentPath = path;

      buffered.set(metric.id, metric);

      if (buffered.size >= maxBatchSize) flush();
    },
    flush,
    pending() {
      return [...buffered.values()];
    },
  };
}

/**
 * The globals the transport needs, named so a test can supply them.
 *
 * `navigator` and `fetch` are read through this rather than off `globalThis` at
 * call time because the interesting cases are precisely the ones a jsdom test
 * cannot produce: a browser without `sendBeacon`, and a `sendBeacon` that
 * returns `false` because the user agent's queue is full.
 */
export interface BeaconEnvironment {
  sendBeacon?: ((url: string, data: BodyInit) => boolean) | undefined;
  fetch?: typeof fetch | undefined;
}

export function readBeaconEnvironment(): BeaconEnvironment {
  const beacon =
    typeof navigator !== "undefined" &&
    typeof navigator.sendBeacon === "function"
      ? navigator.sendBeacon.bind(navigator)
      : undefined;

  return {
    sendBeacon: beacon,
    fetch: typeof fetch === "function" ? fetch : undefined,
  };
}

/**
 * A transport that outlives the document.
 *
 * `navigator.sendBeacon` is the primary because it is the only send the
 * specification requires the user agent to complete after the page is gone —
 * an ordinary `fetch` issued from a `pagehide` handler is cancelled with the
 * document, which is exactly when the final CLS is known. `keepalive: true` is
 * the fallback and gives the same guarantee where it is supported.
 *
 * The body is a `Blob` with an explicit `application/json` type, not a bare
 * string. `sendBeacon` sends a string as `text/plain;charset=UTF-8`, which the
 * route handler's `request.json()` still parses — but only because it does not
 * check the header today, and relying on that means a future content-type
 * check silently drops every metric.
 *
 * Failures are swallowed deliberately. Nothing the visitor can see depends on a
 * metric arriving, and the alternative is an unhandled rejection on the unload
 * path of every page view whenever the collector is down.
 */
export function createBeaconTransport(
  endpoint: string,
  environment: BeaconEnvironment = readBeaconEnvironment(),
): VitalsTransport {
  return (payload) => {
    const body = JSON.stringify(payload);

    // `sendBeacon` returns false when the user agent declines to queue the
    // transfer — usually because the payload exceeds its budget. That is a
    // refusal, not a send, so the fallback has to run.
    if (environment.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      let queued = false;
      try {
        queued = environment.sendBeacon(endpoint, blob);
      } catch {
        queued = false;
      }
      if (queued) return;
    }

    if (!environment.fetch) return;

    void environment
      .fetch(endpoint, {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
        keepalive: true,
        // No cookies. This endpoint authenticates nothing and a credentialed
        // request would attach the session cookie to every page view's beacon
        // for no purpose.
        credentials: "omit",
      })
      .catch(() => {
        // Deliberately empty — see the note above.
      });
  };
}

/** Where the browser posts its metrics. Also asserted by the wiring gate. */
export const VITALS_ENDPOINT = "/api/vitals";
