import { describe, expect, it, vi } from "vitest";
import {
  VITALS_ENDPOINT,
  createBeaconTransport,
  createVitalsQueue,
} from "./queue";
import type { BeaconEnvironment, VitalsTransport } from "./queue";
import type { VitalsPayload, WebVitalsMetric } from "./metric";

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

function collector(): {
  transport: VitalsTransport;
  sent: VitalsPayload[];
} {
  const sent: VitalsPayload[] = [];
  return { transport: (payload) => sent.push(payload), sent };
}

describe("createVitalsQueue", () => {
  it("buffers rather than sending on every metric", () => {
    const { transport, sent } = collector();
    const queue = createVitalsQueue({ transport });

    queue.add("/", metric({ id: "lcp-1" }));
    queue.add("/", metric({ id: "cls-1", name: "CLS", value: 0.02 }));

    expect(sent).toEqual([]);
    expect(queue.pending()).toHaveLength(2);
  });

  it("sends one batch on flush", () => {
    const { transport, sent } = collector();
    const queue = createVitalsQueue({ transport });

    queue.add("/blog", metric({ id: "lcp-1" }));
    queue.add("/blog", metric({ id: "ttfb-1", name: "TTFB", value: 300 }));
    queue.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe("/blog");
    expect(sent[0]?.metrics.map((m) => m.name)).toEqual(["LCP", "TTFB"]);
  });

  it("replaces a revised metric instead of appending it", () => {
    // CLS grows with every layout shift and INP is re-reported whenever a
    // slower interaction displaces the previous one. `web-vitals` reuses the id
    // across those reports, so a queue that appended would send three CLS rows
    // and leave the sink to work out which was final.
    const { transport, sent } = collector();
    const queue = createVitalsQueue({ transport });

    queue.add(
      "/",
      metric({ id: "cls-1", name: "CLS", value: 0.01, delta: 0.01 }),
    );
    queue.add(
      "/",
      metric({ id: "cls-1", name: "CLS", value: 0.09, delta: 0.08 }),
    );
    queue.flush();

    expect(sent[0]?.metrics).toHaveLength(1);
    expect(sent[0]?.metrics[0]?.value).toBe(0.09);
  });

  it("keeps a replaced metric in its original position", () => {
    const { transport, sent } = collector();
    const queue = createVitalsQueue({ transport });

    queue.add("/", metric({ id: "cls-1", name: "CLS", value: 0.01 }));
    queue.add("/", metric({ id: "lcp-1", name: "LCP", value: 900 }));
    queue.add("/", metric({ id: "cls-1", name: "CLS", value: 0.2 }));
    queue.flush();

    expect(sent[0]?.metrics.map((m) => m.name)).toEqual(["CLS", "LCP"]);
  });

  it("does not send an empty batch", () => {
    // Every listener in the reporter can fire on a page that produced no
    // metrics, so this is the common case rather than the edge one — and the
    // payload schema rejects an empty `metrics` array anyway.
    const { transport, sent } = collector();
    const queue = createVitalsQueue({ transport });

    queue.flush();
    queue.flush();

    expect(sent).toEqual([]);
  });

  it("empties the buffer on flush, so a second flush sends nothing", () => {
    const { transport, sent } = collector();
    const queue = createVitalsQueue({ transport });

    queue.add("/", metric());
    queue.flush();
    queue.flush();

    expect(sent).toHaveLength(1);
    expect(queue.pending()).toEqual([]);
  });

  it("flushes the outstanding batch under the path it was measured on", () => {
    // The SPA case. A client-side navigation does not reload the page, so the
    // same reporter keeps feeding the same queue — and attributing the landing
    // page's LCP to whatever the visitor navigated to next is the silent
    // failure this guards.
    const { transport, sent } = collector();
    const queue = createVitalsQueue({ transport });

    queue.add("/", metric({ id: "lcp-1", value: 2400 }));
    queue.add("/blog", metric({ id: "inp-1", name: "INP", value: 120 }));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe("/");
    expect(sent[0]?.metrics.map((m) => m.name)).toEqual(["LCP"]);

    queue.flush();
    expect(sent[1]?.path).toBe("/blog");
    expect(sent[1]?.metrics.map((m) => m.name)).toEqual(["INP"]);
  });

  it("does not send on the first metric, when there is no previous path", () => {
    const { transport, sent } = collector();
    const queue = createVitalsQueue({ transport });

    queue.add("/blog", metric());

    expect(sent).toEqual([]);
  });

  it("flushes automatically once the batch reaches its ceiling", () => {
    // A page that outlives its budget sends two batches rather than one the
    // endpoint would reject as too large.
    const { transport, sent } = collector();
    const queue = createVitalsQueue({ transport, maxBatchSize: 3 });

    queue.add("/", metric({ id: "a" }));
    queue.add("/", metric({ id: "b" }));
    expect(sent).toEqual([]);

    queue.add("/", metric({ id: "c" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.metrics.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(queue.pending()).toEqual([]);
  });

  it("does not overflow on a revision, which replaces rather than grows", () => {
    const { transport, sent } = collector();
    const queue = createVitalsQueue({ transport, maxBatchSize: 2 });

    queue.add("/", metric({ id: "cls-1", value: 0.01 }));
    queue.add("/", metric({ id: "cls-1", value: 0.02 }));
    queue.add("/", metric({ id: "cls-1", value: 0.03 }));

    expect(sent).toEqual([]);
    expect(queue.pending()).toHaveLength(1);
  });

  it("drops the batch when the transport throws, rather than retrying it forever", () => {
    // The transport runs on the unload path. A batch left buffered after a
    // throw is retried by the next flush, which is on a page that is also going
    // away — and the exception propagates into an event handler on every one.
    const failing: VitalsTransport = () => {
      throw new Error("sendBeacon on a torn-down document");
    };
    const queue = createVitalsQueue({ transport: failing });

    queue.add("/", metric());
    expect(() => queue.flush()).toThrow();
    expect(queue.pending()).toEqual([]);
  });
});

describe("createBeaconTransport", () => {
  const payload: VitalsPayload = { path: "/", metrics: [metric()] };

  it("prefers sendBeacon", () => {
    const sendBeacon = vi.fn<(url: string, data: BodyInit) => boolean>(
      () => true,
    );
    const fetchImpl = vi.fn<typeof fetch>();
    const environment: BeaconEnvironment = {
      sendBeacon,
      fetch: fetchImpl,
    };

    createBeaconTransport(VITALS_ENDPOINT, environment)(payload);

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendBeacon.mock.calls[0]?.[0]).toBe("/api/vitals");
  });

  it("sends a Blob typed application/json, not a bare string", () => {
    // `sendBeacon` sends a string as `text/plain;charset=UTF-8`. The route
    // handler parses that today only because it does not check the header —
    // relying on it means a future content-type check drops every metric.
    const sendBeacon = vi.fn<(url: string, data: BodyInit) => boolean>(
      () => true,
    );
    createBeaconTransport(VITALS_ENDPOINT, { sendBeacon })(payload);

    const body = sendBeacon.mock.calls[0]?.[1] as unknown as Blob;
    expect(body).toBeInstanceOf(Blob);
    expect(body.type).toBe("application/json");
  });

  it("falls back to a keepalive fetch when sendBeacon refuses the transfer", () => {
    // `false` means the user agent declined to queue it — a refusal, not a
    // send, so treating it as success loses the batch.
    const sendBeacon = vi.fn<(url: string, data: BodyInit) => boolean>(
      () => false,
    );
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null)),
    );
    createBeaconTransport(VITALS_ENDPOINT, {
      sendBeacon,
      fetch: fetchImpl,
    })(payload);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.keepalive).toBe(true);
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("omit");
    expect(init?.body).toBe(JSON.stringify(payload));
  });

  it("falls back to fetch when sendBeacon throws", () => {
    const sendBeacon = vi.fn<(url: string, data: BodyInit) => boolean>(() => {
      throw new Error("document is gone");
    });
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null)),
    );
    createBeaconTransport(VITALS_ENDPOINT, {
      sendBeacon,
      fetch: fetchImpl,
    })(payload);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to fetch in a browser with no sendBeacon at all", () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null)),
    );
    createBeaconTransport(VITALS_ENDPOINT, {
      fetch: fetchImpl,
    })(payload);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejected fetch rather than raising on the unload path", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error("collector down")),
    );
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    createBeaconTransport(VITALS_ENDPOINT, {
      fetch: fetchImpl,
    })(payload);

    // One turn of the microtask queue plus a macrotask, which is where an
    // unhandled rejection would be reported.
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", unhandled);

    expect(unhandled).not.toHaveBeenCalled();
  });

  it("does nothing at all when neither transport exists", () => {
    expect(() =>
      createBeaconTransport(VITALS_ENDPOINT, {})(payload),
    ).not.toThrow();
  });
});
