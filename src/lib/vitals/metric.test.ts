import { describe, expect, it } from "vitest";
import {
  MAX_BATCH_SIZE,
  MAX_METRIC_VALUE,
  NEXT_METRIC_NAMES,
  THRESHOLDS,
  WEB_VITAL_NAMES,
  isWebVitalName,
  rate,
  rateMetric,
  vitalsPayloadSchema,
  webVitalsMetricSchema,
} from "./metric";
import type { WebVitalsMetric } from "./metric";

function metric(overrides: Partial<WebVitalsMetric> = {}): WebVitalsMetric {
  return {
    id: "v5-1737000000000-1234567890123",
    name: "LCP",
    value: 1200,
    delta: 1200,
    navigationType: "navigate",
    ...overrides,
  };
}

describe("rate", () => {
  it("puts a value at the good boundary in `good`, not `needs-improvement`", () => {
    // The boundaries are inclusive on the lower side in web.dev's definition;
    // an exclusive comparison here would report every page that hit its target
    // exactly as having missed it.
    expect(rate("LCP", THRESHOLDS.LCP[0])).toBe("good");
    expect(rate("CLS", THRESHOLDS.CLS[0])).toBe("good");
  });

  it("puts a value at the upper boundary in `needs-improvement`, not `poor`", () => {
    expect(rate("LCP", THRESHOLDS.LCP[1])).toBe("needs-improvement");
  });

  it("puts a value above the upper boundary in `poor`", () => {
    expect(rate("LCP", THRESHOLDS.LCP[1] + 1)).toBe("poor");
    expect(rate("TTFB", 5000)).toBe("poor");
  });

  it("rates every Core Web Vital and no Next timing", () => {
    for (const name of WEB_VITAL_NAMES) {
      expect(rate(name, 0)).toBe("good");
    }
    for (const name of NEXT_METRIC_NAMES) {
      expect(rate(name, 0)).toBe("unrated");
    }
  });

  it("reports the -1 sentinel as unrated rather than as the best possible score", () => {
    // `web-vitals` uses -1 for "this metric was never measured". Every
    // threshold comparison is a `<=`, so the obvious implementation records
    // the absence of a measurement as `good` and quietly improves the p75.
    expect(rate("LCP", -1)).toBe("unrated");
    expect(rate("CLS", -1)).toBe("unrated");
  });

  it("reports a non-finite value as unrated", () => {
    expect(rate("LCP", Number.NaN)).toBe("unrated");
    expect(rate("LCP", Number.POSITIVE_INFINITY)).toBe("unrated");
  });
});

describe("isWebVitalName", () => {
  it("accepts the Core Web Vitals and rejects the Next timings", () => {
    expect(isWebVitalName("INP")).toBe(true);
    expect(isWebVitalName("Next.js-hydration")).toBe(false);
    expect(isWebVitalName("lcp")).toBe(false);
  });
});

describe("webVitalsMetricSchema", () => {
  it("accepts a metric as the browser reports it", () => {
    expect(webVitalsMetricSchema.parse(metric())).toEqual(metric());
  });

  it("accepts every name the bundled web-vitals build can emit", () => {
    for (const name of [...WEB_VITAL_NAMES, ...NEXT_METRIC_NAMES]) {
      expect(webVitalsMetricSchema.safeParse(metric({ name })).success).toBe(
        true,
      );
    }
  });

  it("still accepts FID, which old browsers report and new ones do not", () => {
    // Dropping it from the enum would fail validation on a real measurement
    // from a browser that has not moved to INP.
    expect(
      webVitalsMetricSchema.safeParse(metric({ name: "FID" })).success,
    ).toBe(true);
  });

  it("rejects a name outside the list", () => {
    const result = webVitalsMetricSchema.safeParse(
      metric({ name: "CPU" as WebVitalsMetric["name"] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a value above the ceiling", () => {
    // One posted 1e308 moves every mean computed over this data.
    expect(
      webVitalsMetricSchema.safeParse(metric({ value: MAX_METRIC_VALUE + 1 }))
        .success,
    ).toBe(false);
    expect(
      webVitalsMetricSchema.safeParse(metric({ value: Number.MAX_VALUE }))
        .success,
    ).toBe(false);
  });

  it("rejects a negative or non-finite value", () => {
    expect(webVitalsMetricSchema.safeParse(metric({ value: -1 })).success).toBe(
      false,
    );
    expect(
      webVitalsMetricSchema.safeParse(metric({ value: Number.NaN })).success,
    ).toBe(false);
  });

  it("allows a negative delta, because INP revisions can move downwards", () => {
    expect(
      webVitalsMetricSchema.safeParse(metric({ delta: -40 })).success,
    ).toBe(true);
  });

  it("rejects an unknown key rather than stripping it", () => {
    // `web-vitals` attaches an `entries` array of raw PerformanceEntry objects,
    // and an LCP entry names the element it measured — including, for a text
    // node, its content. Stripping would be enough; rejecting is what makes
    // forwarding a new field a decision someone makes on purpose.
    const result = webVitalsMetricSchema.safeParse({
      ...metric(),
      entries: [{ element: "<h1>Reset your password</h1>" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown navigationType", () => {
    expect(
      webVitalsMetricSchema.safeParse(
        metric({
          navigationType: "teleport" as WebVitalsMetric["navigationType"],
        }),
      ).success,
    ).toBe(false);
  });
});

describe("vitalsPayloadSchema", () => {
  it("accepts a batch", () => {
    const parsed = vitalsPayloadSchema.parse({
      path: "/blog/hello-world",
      metrics: [metric(), metric({ id: "cls-1", name: "CLS", value: 0.04 })],
    });
    expect(parsed.metrics).toHaveLength(2);
  });

  it("rejects an empty batch", () => {
    // An empty beacon is a request that costs the limiter and the log and
    // carries nothing; the queue declines to send one and this is the other
    // half of that.
    expect(
      vitalsPayloadSchema.safeParse({ path: "/", metrics: [] }).success,
    ).toBe(false);
  });

  it("rejects a batch above the ceiling", () => {
    const metrics = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, index) =>
      metric({ id: `m-${index}` }),
    );
    expect(vitalsPayloadSchema.safeParse({ path: "/", metrics }).success).toBe(
      false,
    );
  });

  it("rejects a path carrying a query string or a fragment", () => {
    // This is the field that would carry a search term, a share token or an
    // OAuth `code` into the log drain if the client sent `location.href`.
    for (const path of [
      "/search?q=my+medical+condition",
      "/reset#token=abc",
      "https://example.com/blog",
      "blog",
      "",
    ]) {
      expect(
        vitalsPayloadSchema.safeParse({ path, metrics: [metric()] }).success,
      ).toBe(false);
    }
  });

  it("accepts an ordinary path, including the root", () => {
    for (const path of ["/", "/blog", "/blog/hello-world", "/photos/12"]) {
      expect(
        vitalsPayloadSchema.safeParse({ path, metrics: [metric()] }).success,
      ).toBe(true);
    }
  });

  it("rejects an unknown top-level key", () => {
    expect(
      vitalsPayloadSchema.safeParse({
        path: "/",
        metrics: [metric()],
        userId: "usr_123",
      }).success,
    ).toBe(false);
  });
});

describe("rateMetric", () => {
  it("attaches the rating without disturbing the measurement", () => {
    const rated = rateMetric(metric({ name: "CLS", value: 0.3 }));
    expect(rated.rating).toBe("poor");
    expect(rated.value).toBe(0.3);
    expect(rated.name).toBe("CLS");
  });

  it("ignores any rating the client supplied", () => {
    // The schema rejects the extra key outright, which is the strongest form
    // of "the client does not get to grade its own performance".
    const result = webVitalsMetricSchema.safeParse({
      ...metric({ value: 9000 }),
      rating: "good",
    });
    expect(result.success).toBe(false);
  });
});
