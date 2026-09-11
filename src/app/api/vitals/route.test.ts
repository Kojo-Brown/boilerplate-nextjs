import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import type { VitalsAck } from "./route";
import type { VitalsLogLine } from "@/lib/vitals/sink";
import type { ApiErrorBody } from "@/lib/api/errors";
import type { WebVitalsMetric } from "@/lib/vitals/metric";

function metric(overrides: Partial<WebVitalsMetric> = {}): WebVitalsMetric {
  return {
    id: "lcp-1",
    name: "LCP",
    value: 1200,
    delta: 1200,
    navigationType: "navigate",
    ...overrides,
  };
}

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest(
      new Request("https://example.test/api/vitals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

/** The lines the default sink wrote during `run`. */
async function captureLog(run: () => Promise<Response>): Promise<{
  response: Response;
  lines: VitalsLogLine[];
}> {
  const written: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    written.push(String(line));
  });
  try {
    const response = await run();
    return {
      response,
      lines: written.map((line) => JSON.parse(line) as VitalsLogLine),
    };
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/vitals", () => {
  it("answers 202, because delivery is not something the caller waits for", async () => {
    const { response } = await captureLog(() =>
      post({ path: "/blog", metrics: [metric()] }),
    );

    expect(response.status).toBe(202);
    expect(((await response.json()) as VitalsAck).accepted).toBe(1);
  });

  it("ships every metric in the batch to the sink", async () => {
    const { lines } = await captureLog(() =>
      post({
        path: "/blog",
        metrics: [
          metric({ id: "lcp-1", name: "LCP", value: 1200 }),
          metric({ id: "cls-1", name: "CLS", value: 0.02, delta: 0.02 }),
          metric({ id: "ttfb-1", name: "TTFB", value: 300 }),
        ],
      }),
    );

    expect(lines.map((line) => line.metric.name)).toEqual([
      "LCP",
      "CLS",
      "TTFB",
    ]);
    expect(lines.every((line) => line.path === "/blog")).toBe(true);
  });

  it("rates each metric on the server rather than trusting the client", async () => {
    // The client can post anything; a rating it supplied would be a claim about
    // its own performance. The schema rejects the field outright and the server
    // derives it from `THRESHOLDS`.
    const { lines } = await captureLog(() =>
      post({
        path: "/",
        metrics: [
          metric({ id: "a", name: "LCP", value: 900 }),
          metric({ id: "b", name: "LCP", value: 3200 }),
          metric({ id: "c", name: "LCP", value: 9000 }),
          metric({ id: "d", name: "Next.js-hydration", value: 40 }),
        ],
      }),
    );

    expect(lines.map((line) => line.metric.rating)).toEqual([
      "good",
      "needs-improvement",
      "poor",
      "unrated",
    ]);
  });

  it("stamps the arrival time from the server clock, once per batch", async () => {
    const { lines } = await captureLog(() =>
      post({
        path: "/",
        metrics: [
          metric({ id: "a" }),
          metric({ id: "b", name: "CLS", value: 0 }),
        ],
      }),
    );

    const [first, second] = lines;
    expect(first?.receivedAt).toBe(second?.receivedAt);
    expect(Number.isNaN(Date.parse(first?.receivedAt ?? ""))).toBe(false);
  });

  it("rejects a batch whose metric name is not one the browser can emit", async () => {
    const response = await post({
      path: "/",
      metrics: [{ ...metric(), name: "CPU" }],
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiErrorBody;
    // The 422 names the offending metric by its position in the batch, which is
    // the difference between a debuggable rejection and "Invalid body".
    expect(Object.keys(body.error.fieldErrors ?? {})).toContain(
      "body.metrics.0.name",
    );
  });

  it("rejects a path carrying a query string", async () => {
    // This endpoint writes what it is given into a log drain, and a query
    // string on a real page is where the search term and the OAuth `code` are.
    const response = await post({
      path: "/search?q=my+medical+condition",
      metrics: [metric()],
    });

    expect(response.status).toBe(422);
  });

  it("rejects the raw PerformanceEntry array the browser attaches", async () => {
    const response = await post({
      path: "/",
      metrics: [
        { ...metric(), entries: [{ element: "<h1>Reset your password</h1>" }] },
      ],
    });

    expect(response.status).toBe(422);
  });

  it("rejects an empty batch", async () => {
    expect((await post({ path: "/", metrics: [] })).status).toBe(422);
  });

  it("rejects a batch above the size ceiling", async () => {
    const metrics = Array.from({ length: 21 }, (_, index) =>
      metric({ id: `m-${index}` }),
    );
    expect((await post({ path: "/", metrics })).status).toBe(422);
  });

  it("rejects a body that is not JSON", async () => {
    const response = await POST(
      new NextRequest(
        new Request("https://example.test/api/vitals", {
          method: "POST",
          body: "not json",
        }),
      ),
    );
    expect(response.status).toBe(400);
  });

  it("still answers 202 when the sink fails, and records the failure", async () => {
    // A sink failure must not become a 5xx: this endpoint is hit once per page
    // view, so a collector outage handled the obvious way puts the
    // application's own error rate through the roof and pages whoever is on
    // call — for telemetry.
    vi.stubEnv("VITALS_COLLECTOR_URL", "https://collector.example/ingest");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ENOTFOUND collector.example"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post({ path: "/", metrics: [metric()] });

    expect(response.status).toBe(202);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("[vitals]");
  });

  it("forwards to the configured collector instead of the log", async () => {
    vi.stubEnv("VITALS_COLLECTOR_URL", "https://collector.example/ingest");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));

    const { response, lines } = await captureLog(() =>
      post({ path: "/blog", metrics: [metric()] }),
    );

    expect(response.status).toBe(202);
    expect(lines).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toHaveLength(1);
  });
});
