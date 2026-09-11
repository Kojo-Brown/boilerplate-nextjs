/**
 * The vocabulary of a Web Vitals measurement, shared by the browser that takes
 * it and the endpoint that receives it.
 *
 * This module is deliberately isomorphic — Zod and nothing else. The client
 * bundle imports it to shape what it sends and the route handler imports it to
 * validate what arrives, and the point of that is that there is exactly one
 * definition of the wire format rather than two that agree until one is edited.
 *
 * ## Why the payload is validated at all
 *
 * `POST /api/vitals` is unauthenticated, and it has to be: the metrics worth
 * having are the ones from the first paint of a page a signed-out visitor
 * landed on, before any session exists. So the body is attacker-controlled in
 * the ordinary case, not the exotic one, and every field below is bounded on
 * purpose — a metric name against a closed list, a value against a ceiling, the
 * batch against a length. Without that, "ship it to the sink" means "write
 * whatever was posted into the log drain the on-call engineer greps".
 *
 * ## Why the client's own metric type is not imported from Next
 *
 * `next/web-vitals` declares its callback as `(metric: Metric) => void` where
 * `Metric` comes from `next/dist/compiled/web-vitals` — a bundled copy that
 * ships no type declarations. The import resolves to `any`, so annotating
 * against it buys nothing and hides the fact that the value is untyped. The
 * reporter therefore takes the callback argument as `unknown` and narrows it
 * through `webVitalsMetricSchema` below, which is a real check rather than a
 * cast, and which is the same schema the server applies.
 */
import { z } from "zod";

/**
 * The Core Web Vitals the bundled `web-vitals` build can emit.
 *
 * Read off the bundle rather than from memory: FID is still in there (Next's
 * own `WEB_VITALS` constant lists it) even though the web no longer reports it
 * for new page loads, and leaving it out would make a real metric fail
 * validation on the day it arrives from an old browser.
 */
export const WEB_VITAL_NAMES = [
  "CLS",
  "FCP",
  "FID",
  "INP",
  "LCP",
  "TTFB",
] as const;

export type WebVitalName = (typeof WEB_VITAL_NAMES)[number];

/**
 * Next's own timings, reported through the same hook.
 *
 * They are not Core Web Vitals and should not be charted beside them — the
 * thresholds below do not apply and `rating` is always `"unrated"` for these —
 * but they are the measurements that answer "is this the framework or the
 * network?", so they are collected rather than dropped.
 */
export const NEXT_METRIC_NAMES = [
  "Next.js-hydration",
  "Next.js-route-change-to-render",
  "Next.js-render",
] as const;

export type NextMetricName = (typeof NEXT_METRIC_NAMES)[number];

export type MetricName = WebVitalName | NextMetricName;

/**
 * How the page was loaded, as `web-vitals` classifies it.
 *
 * This is not decoration. A `back-forward-cache` restore has an LCP measured
 * from the restore rather than from a network fetch, which is why a site with a
 * healthy bfcache hit rate looks faster than it is when the two are pooled;
 * keeping the classification on every row is what lets the sink separate them.
 */
export const NAVIGATION_TYPES = [
  "navigate",
  "reload",
  "back-forward",
  "back-forward-cache",
  "prerender",
  "restore",
] as const;

export type NavigationType = (typeof NAVIGATION_TYPES)[number];

/** Google's buckets. `unrated` is this repository's, for the Next timings. */
export const RATINGS = [
  "good",
  "needs-improvement",
  "poor",
  "unrated",
] as const;

export type Rating = (typeof RATINGS)[number];

/**
 * The good/needs-improvement boundaries, in the metric's own unit.
 *
 * `[good, needsImprovement]`: at or below the first is `good`, at or below the
 * second is `needs-improvement`, above it is `poor`. Milliseconds everywhere
 * except CLS, which is a unitless layout-shift score.
 *
 * Duplicated from web.dev rather than read off the metric's own `rating` field
 * on purpose. The browser's rating is computed by whichever version of
 * `web-vitals` Next happens to bundle, so a Next upgrade could silently move
 * the line between "good" and "poor" in a dashboard covering both sides of it.
 * Rating here, from a table in the repository, means a threshold change is a
 * diff someone reviews.
 */
export const THRESHOLDS: Readonly<
  Record<WebVitalName, readonly [number, number]>
> = {
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  FID: [100, 300],
  INP: [200, 500],
  LCP: [2500, 4000],
  TTFB: [800, 1800],
};

export function isWebVitalName(name: string): name is WebVitalName {
  return (WEB_VITAL_NAMES as readonly string[]).includes(name);
}

/**
 * The bucket a value falls in, or `unrated` for a metric with no published
 * thresholds.
 *
 * A negative value is `unrated` rather than `good`. `web-vitals` reports `-1`
 * as its "not measured" sentinel for a metric whose entry never arrived, and
 * `-1 <= 0.1` is true — so the obvious comparison silently records the absence
 * of a measurement as the best possible one.
 */
export function rate(name: MetricName, value: number): Rating {
  if (!isWebVitalName(name)) return "unrated";
  if (!Number.isFinite(value) || value < 0) return "unrated";

  const [good, needsImprovement] = THRESHOLDS[name];
  if (value <= good) return "good";
  if (value <= needsImprovement) return "needs-improvement";
  return "poor";
}

/**
 * The largest value any metric may report, in its own unit.
 *
 * A ceiling rather than no bound at all, because `value` ends up in a sink that
 * averages it: one posted `1e308` moves a mean for every dashboard that reads
 * it, and no browser produces a real figure anywhere near this. An hour is
 * comfortably above the worst TTFB a real connection yields and far below the
 * range where a single row can distort an aggregate.
 */
export const MAX_METRIC_VALUE = 3_600_000;

/**
 * One measurement, as the browser hands it over.
 *
 * `.strict()` matters here: `web-vitals` attaches an `entries` array of raw
 * `PerformanceEntry` objects to every metric, and an LCP entry carries the
 * element it measured — including, for a text node, its content. Silently
 * dropping unknown keys would be enough, but rejecting them is what makes a
 * future field an explicit decision to forward it rather than something that
 * arrives in the log drain because the browser started sending it.
 */
export const webVitalsMetricSchema = z
  .object({
    /** `web-vitals` mints one id per metric per page load; the batch key. */
    id: z.string().min(1).max(128),
    name: z.enum([...WEB_VITAL_NAMES, ...NEXT_METRIC_NAMES]),
    value: z.number().finite().min(0).max(MAX_METRIC_VALUE),
    /**
     * Change since this metric was last reported. CLS and INP are reported
     * repeatedly as the page evolves, so a sink that sums `value` across
     * reports double-counts; `delta` is what it should sum instead.
     */
    delta: z.number().finite().min(-MAX_METRIC_VALUE).max(MAX_METRIC_VALUE),
    navigationType: z.enum(NAVIGATION_TYPES),
  })
  .strict();

export type WebVitalsMetric = z.infer<typeof webVitalsMetricSchema>;

/**
 * The most metrics one request may carry.
 *
 * Five Core Web Vitals plus three Next timings is eight per page load, and INP
 * and CLS can each report more than once before the flush. Twenty leaves room
 * for that on a long-lived page without letting one beacon carry a thousand
 * rows.
 */
export const MAX_BATCH_SIZE = 20;

/**
 * The path the metrics were measured on.
 *
 * The pathname only — never `location.href`. A query string on a real page is
 * where the search term, the share token and the OAuth `code` live, and this
 * endpoint writes what it is given straight into a log drain. Bounded because
 * a path segment is caller-controlled, and pattern-checked because a value
 * that is not a path is not a page and should not be charted as one.
 */
export const vitalsPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\/[^\s?#]*$/, "must be an absolute path with no query or fragment");

export const vitalsPayloadSchema = z
  .object({
    path: vitalsPathSchema,
    metrics: z.array(webVitalsMetricSchema).min(1).max(MAX_BATCH_SIZE),
  })
  .strict();

export type VitalsPayload = z.infer<typeof vitalsPayloadSchema>;

/**
 * A metric with its rating attached — what reaches a sink.
 *
 * The rating is computed on the server, from `THRESHOLDS` above, rather than
 * forwarded from the client. A client-supplied rating is a client-supplied
 * claim about its own performance, and this endpoint accepts anything that can
 * post JSON.
 */
export interface RatedMetric extends WebVitalsMetric {
  rating: Rating;
}

export function rateMetric(metric: WebVitalsMetric): RatedMetric {
  return { ...metric, rating: rate(metric.name, metric.value) };
}
