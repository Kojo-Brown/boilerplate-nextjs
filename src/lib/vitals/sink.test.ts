import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HTTP_SINK_TIMEOUT_MS,
  VITALS_LOG_EVENT,
  createHttpSink,
  createLogSink,
  resolveVitalsSink,
} from "./sink";
import type { VitalsEvent, VitalsLogLine } from "./sink";

function event(overrides: Partial<VitalsEvent> = {}): VitalsEvent {
  return {
    path: "/blog",
    metric: {
      id: "lcp-1",
      name: "LCP",
      value: 1200,
      delta: 1200,
      navigationType: "navigate",
      rating: "good",
    },
    receivedAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("createLogSink", () => {
  it("writes one JSON line per metric, not one per batch", () => {
    // Every query anyone writes against this data groups by metric name and
    // path; a row per metric makes that a filter instead of a JSON traversal
    // inside the query.
    const lines: string[] = [];
    const sink = createLogSink((line) => lines.push(line));

    sink.deliver([
      event(),
      event({ metric: { ...event().metric, id: "cls-1", name: "CLS" } }),
    ]);

    expect(lines).toHaveLength(2);
  });

  it("writes a parseable line carrying the discriminator", () => {
    const lines: string[] = [];
    createLogSink((line) => lines.push(line)).deliver([event()]);

    const parsed = JSON.parse(lines[0] ?? "") as VitalsLogLine;
    expect(parsed.event).toBe(VITALS_LOG_EVENT);
    expect(parsed.path).toBe("/blog");
    expect(parsed.metric.name).toBe("LCP");
    expect(parsed.metric.rating).toBe("good");
    expect(parsed.receivedAt).toBe("2026-09-11T00:00:00.000Z");
  });

  it("writes nothing for an empty batch", () => {
    const lines: string[] = [];
    createLogSink((line) => lines.push(line)).deliver([]);
    expect(lines).toEqual([]);
  });

  it("identifies itself", () => {
    expect(createLogSink(() => {}).name).toBe("log");
  });
});

describe("createHttpSink", () => {
  function okResponse(): Response {
    return new Response(null, { status: 202 });
  }

  it("forwards the whole batch as one request", () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(okResponse()));
    const sink = createHttpSink({
      url: "https://collector.example/ingest",
      fetchImpl,
    });

    void sink.deliver([event(), event({ path: "/" })]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://collector.example/ingest");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toHaveLength(2);
  });

  it("sends the token as a bearer credential when one is configured", () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(okResponse()));
    void createHttpSink({
      url: "https://collector.example/ingest",
      token: "mock-collector-key",
      fetchImpl,
    }).deliver([event()]);

    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer mock-collector-key");
  });

  it("sends no authorization header when no token is configured", () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(okResponse()));
    void createHttpSink({
      url: "https://collector.example/ingest",
      fetchImpl,
    }).deliver([event()]);

    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBeUndefined();
  });

  it("bounds the forward with an abort signal", () => {
    // This runs inside the request the beacon opened. A collector that accepts
    // connections and then stalls would otherwise hold a server task open per
    // page view, which is how a telemetry outage becomes an application one.
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(okResponse()));
    void createHttpSink({
      url: "https://collector.example/ingest",
      fetchImpl,
    }).deliver([event()]);

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(DEFAULT_HTTP_SINK_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("rejects when the collector answers non-2xx", async () => {
    // The only way anyone learns the collector has been refusing everything
    // for a week is this rejection reaching the handler's log line.
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    );
    const sink = createHttpSink({
      url: "https://collector.example/ingest",
      fetchImpl,
    });

    await expect(sink.deliver([event()])).rejects.toThrow(/401/);
  });

  it("propagates a transport failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error("ENOTFOUND")),
    );
    const sink = createHttpSink({
      url: "https://collector.example/ingest",
      fetchImpl,
    });

    await expect(sink.deliver([event()])).rejects.toThrow("ENOTFOUND");
  });

  it("identifies itself", () => {
    expect(createHttpSink({ url: "https://collector.example" }).name).toBe(
      "http",
    );
  });
});

describe("resolveVitalsSink", () => {
  it("selects the log sink when no collector is configured", () => {
    // Unset is the supported default, not a disabled state: a boilerplate whose
    // telemetry is off until someone finds an API key ships telemetry nobody
    // has seen work.
    expect(resolveVitalsSink({}).name).toBe("log");
  });

  it("treats an empty collector URL as unset", () => {
    // `.env.example` ships `VITALS_COLLECTOR_URL=`, which sets the variable to
    // the empty string — present, and not a URL.
    expect(resolveVitalsSink({ VITALS_COLLECTOR_URL: "" }).name).toBe("log");
  });

  it("selects the http sink when a collector is configured", () => {
    expect(
      resolveVitalsSink({
        VITALS_COLLECTOR_URL: "https://collector.example/ingest",
      }).name,
    ).toBe("http");
  });
});
