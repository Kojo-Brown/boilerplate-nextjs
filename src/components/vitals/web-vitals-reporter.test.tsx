import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { act } from "react";
import { WebVitalsReporter } from "./web-vitals-reporter";
import type { VitalsPayload } from "@/lib/vitals/metric";

/**
 * `useReportWebVitals` subscribes to the browser's PerformanceObserver, which
 * jsdom does not implement — so the hook is replaced by one that hands the test
 * the callback and lets it deliver measurements directly. That keeps the
 * assertions about *this component's* behaviour (what it buffers, when it
 * flushes, which path it attributes a metric to) rather than about whether
 * jsdom can produce an LCP entry, which it cannot.
 */
const reporters: ((metric: unknown) => void)[] = [];

vi.mock("next/web-vitals", () => ({
  useReportWebVitals: (callback: (metric: unknown) => void) => {
    // Pushed on every render rather than only the first, so that the
    // "one stable callback" case below can count the distinct identities the
    // hook was handed — the property that keeps `web-vitals` from accumulating
    // a fresh set of subscriptions per render.
    reporters.push(callback);
  },
}));

function report(metric: unknown): void {
  const callback = reporters.at(-1);
  if (!callback) throw new Error("the reporter never subscribed");
  act(() => {
    callback(metric);
  });
}

function metric(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "lcp-1",
    name: "LCP",
    value: 1200,
    delta: 1200,
    navigationType: "navigate",
    ...overrides,
  };
}

/**
 * Drives the URL the way a client-side navigation does.
 *
 * The reporter reads `location.pathname` rather than `usePathname` — see its
 * docblock for why a per-request read in the root layout was the wrong tool —
 * so the honest way to describe a navigation here is to perform one.
 */
function navigateTo(path: string): void {
  window.history.pushState({}, "", path);
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

let sent: VitalsPayload[];

beforeEach(() => {
  reporters.length = 0;
  sent = [];
  setVisibility("visible");
  navigateTo("/");
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderReporter() {
  return render(
    <WebVitalsReporter transport={(payload) => sent.push(payload)} />,
  );
}

describe("WebVitalsReporter", () => {
  it("renders nothing", () => {
    const { container } = renderReporter();
    expect(container).toBeEmptyDOMElement();
  });

  it("buffers rather than posting on every measurement", () => {
    renderReporter();

    report(metric({ id: "lcp-1", name: "LCP" }));
    report(metric({ id: "ttfb-1", name: "TTFB", value: 300 }));

    expect(sent).toEqual([]);
  });

  it("flushes when the page is hidden", () => {
    // `visibilitychange` to hidden is the last callback a page is guaranteed
    // to get: `unload` and `beforeunload` are not dispatched at all on mobile
    // Safari, and registering either disqualifies the page from the bfcache.
    renderReporter();
    report(metric());

    setVisibility("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.metrics).toHaveLength(1);
  });

  it("does not flush when the page becomes visible again", () => {
    renderReporter();
    report(metric());

    setVisibility("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(sent).toEqual([]);
  });

  it("flushes on pagehide", () => {
    renderReporter();
    report(metric());

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(sent).toHaveLength(1);
  });

  it("sends one batch when both listeners fire, because the queue is empty after the first", () => {
    renderReporter();
    report(metric());

    setVisibility("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(sent).toHaveLength(1);
  });

  it("attributes a metric to the path it was measured on, not the one navigated to", () => {
    // The SPA failure this guards: a client-side navigation changes the URL
    // without reloading, so a flush that read `location.pathname` would file
    // the landing page's LCP under wherever the visitor went next.
    navigateTo("/");
    renderReporter();

    report(metric({ id: "lcp-1", name: "LCP", value: 2400 }));

    navigateTo("/blog");
    report(metric({ id: "inp-1", name: "INP", value: 120 }));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe("/");
    expect(sent[0]?.metrics.map((m) => m.name)).toEqual(["LCP"]);

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(sent[1]?.path).toBe("/blog");
    expect(sent[1]?.metrics.map((m) => m.name)).toEqual(["INP"]);
  });

  it("hands the hook one stable callback, however often it re-renders", () => {
    // `useReportWebVitals` is `useEffect(() => { onCLS(fn); … }, [fn])`, and
    // `web-vitals`'s `onX` functions return no teardown — so a new function
    // identity does not replace the previous subscription, it adds one. An
    // inline closure would register a fresh set of six listeners per render,
    // and one layout shift would then be reported once per render the page had
    // ever done.
    const { rerender } = renderReporter();

    rerender(<WebVitalsReporter transport={(payload) => sent.push(payload)} />);
    rerender(<WebVitalsReporter transport={(payload) => sent.push(payload)} />);

    expect(new Set(reporters).size).toBe(1);
  });

  it("keeps one queue across re-renders, so nothing buffered is lost", () => {
    const { rerender } = renderReporter();
    report(metric({ id: "lcp-1" }));

    rerender(<WebVitalsReporter transport={(payload) => sent.push(payload)} />);
    report(metric({ id: "cls-1", name: "CLS", value: 0.02, delta: 0.02 }));

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(sent[0]?.metrics).toHaveLength(2);
  });

  it("drops a measurement the endpoint would reject rather than spending a request on it", () => {
    renderReporter();

    // `next/web-vitals` types this argument as `any`, so nothing upstream
    // guarantees the shape. Each of these is a real possibility: a metric name
    // the schema does not know, the raw PerformanceEntry array the browser
    // attaches, and a `value` of -1 for a metric that was never measured.
    report(metric({ name: "CPU" }));
    report({ ...(metric() as object), entries: [{ element: "<h1>x</h1>" }] });
    report(metric({ value: -1 }));
    report(null);
    report(undefined);

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(sent).toEqual([]);
  });

  it("replaces a revised metric instead of reporting it twice", () => {
    renderReporter();

    report(metric({ id: "cls-1", name: "CLS", value: 0.01, delta: 0.01 }));
    report(metric({ id: "cls-1", name: "CLS", value: 0.18, delta: 0.17 }));

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(sent[0]?.metrics).toHaveLength(1);
    expect(sent[0]?.metrics[0]?.value).toBe(0.18);
  });

  it("sends nothing when the page produced no measurements", () => {
    renderReporter();

    setVisibility("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(sent).toEqual([]);
  });

  it("flushes on unmount and removes both listeners", () => {
    const { unmount } = renderReporter();
    report(metric());

    unmount();
    expect(sent).toHaveLength(1);

    // A listener surviving the unmount would flush an empty queue forever, and
    // would hold a reference to a component React has discarded.
    setVisibility("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(sent).toHaveLength(1);
  });
});
