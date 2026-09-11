/**
 * Where a measurement goes once the endpoint has accepted it.
 *
 * "Shipped to an analytics sink" is the part of this feature that differs per
 * deployment, and it is the part most likely to be replaced first — a team on
 * Vercel wants the built-in analytics, a team on ECS wants the log drain that
 * already exists, a team with a Datadog contract wants Datadog. So the sink is
 * an interface with the deployment-independent implementation as the default,
 * rather than a call to a specific vendor's SDK buried in the route handler.
 *
 * ## Why the default writes a log line
 *
 * Because it is the only sink that works everywhere without configuration and
 * without a dependency. Every platform this boilerplate targets collects
 * stdout, and every log platform that collects stdout can parse a JSON line —
 * so `logSink` produces queryable data on Vercel, on CloudWatch, on Loki and in
 * `docker logs`, on the first deploy, with nothing set. A default that required
 * an API key would mean this feature ships disabled, which is the state it is
 * already in.
 *
 * `console.log` rather than a logging library for the same reason: adding one
 * would make the sink's output depend on a transport that has to be configured
 * before the fallback works.
 *
 * ## Why one line per metric, not one per batch
 *
 * A batch is a transport artefact — it exists because beacons are expensive,
 * not because the metrics in it belong together. Every query anyone writes
 * against this data groups by metric name and path ("p75 LCP on /blog this
 * week"), and a row per metric is what makes that a filter rather than a JSON
 * traversal inside the query.
 */
import type { RatedMetric } from "./metric";

/** One measurement, with everything the server knows about it attached. */
export interface VitalsEvent {
  /** The path the metric was measured on, as validated by the payload schema. */
  path: string;
  metric: RatedMetric;
  /** When the server accepted it, ISO 8601. The client's clock is not used. */
  receivedAt: string;
}

export interface VitalsSink {
  /** Identifies the sink in logs and in `/api/health`-style introspection. */
  name: string;
  /**
   * Delivers a batch.
   *
   * May be async, and the route handler awaits it — see the note on the
   * endpoint about why this is not fire-and-forget on the server side.
   */
  deliver: (events: readonly VitalsEvent[]) => Promise<void> | void;
}

/** The shape of a `logSink` line. Exported so the tests assert against a type. */
export interface VitalsLogLine extends VitalsEvent {
  /**
   * A fixed discriminator, so a log query can select these rows without
   * matching on the shape of the object. Every other line this application
   * writes is prose; this is the one that is meant to be parsed.
   */
  event: "web-vitals";
}

export const VITALS_LOG_EVENT = "web-vitals" as const;

/**
 * The deployment-independent default: one JSON line per metric on stdout.
 *
 * `write` is injected so the tests capture lines rather than reaching into the
 * global console, and so a deployment that has a structured logger can pass its
 * own writer without reimplementing the shape.
 */
export function createLogSink(
  write: (line: string) => void = (line) => {
    console.log(line);
  },
): VitalsSink {
  return {
    name: "log",
    deliver(events) {
      for (const event of events) {
        const line: VitalsLogLine = { event: VITALS_LOG_EVENT, ...event };
        write(JSON.stringify(line));
      }
    },
  };
}

export interface HttpSinkOptions {
  /** The collector's ingest URL. */
  url: string;
  /**
   * Sent as `Authorization: Bearer …` when present.
   *
   * Read from the environment by `resolveVitalsSink`, never from the request —
   * this is the server's credential for the collector and has nothing to do
   * with the visitor whose page produced the metric.
   */
  token?: string | undefined;
  /**
   * How long to wait before abandoning the forward, in milliseconds.
   *
   * A timeout is not optional here. This runs inside the request the browser's
   * beacon opened, and a collector that accepts connections and then stalls
   * would otherwise hold a server task open per page view until the platform's
   * own limit killed it — which is how a telemetry outage becomes an
   * application outage.
   */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_HTTP_SINK_TIMEOUT_MS = 2_000;

/**
 * Forwards the batch to an HTTP collector.
 *
 * The batch goes as one request with an array body, which is what every
 * ingest API in this space accepts and is the shape that keeps the forward at
 * one request per beacon rather than one per metric.
 *
 * A non-2xx response throws, and so does a timeout. The endpoint's own handler
 * decides what that means for the visitor — it means nothing, and the answer is
 * still 202 — but the sink must not report a delivery it did not make, because
 * the only way anyone learns the collector has been rejecting everything for a
 * week is the error this raises.
 */
export function createHttpSink({
  url,
  token,
  timeoutMs = DEFAULT_HTTP_SINK_TIMEOUT_MS,
  fetchImpl = fetch,
}: HttpSinkOptions): VitalsSink {
  return {
    name: "http",
    async deliver(events) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (token) headers["authorization"] = `Bearer ${token}`;

      // `AbortSignal.timeout` rather than a `setTimeout` plus a controller: it
      // needs no clearing, so it cannot leak a timer when the fetch settles
      // first, which the hand-rolled version does on every successful forward.
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(events),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(
          `vitals collector rejected the batch: ${response.status} ${response.statusText}`,
        );
      }
    },
  };
}

/**
 * The sink this deployment uses.
 *
 * Chosen from the environment at call time rather than at module load: the
 * route handler asks once per request, which costs a property read, and the
 * alternative is a module-level constant baked in at build time that a
 * deployment cannot change without rebuilding the image.
 *
 * `VITALS_COLLECTOR_URL` unset — the case for every local checkout and the
 * default for every deploy — selects the log sink. That is the whole
 * configuration surface: there is no on/off switch, because a boilerplate whose
 * telemetry is off by default ships telemetry nobody has ever seen work.
 */
/**
 * The environment, narrowed to the two variables this module reads.
 *
 * The index signature is what keeps `process.env` assignable to it —
 * `NodeJS.ProcessEnv` carries a required `NODE_ENV`, so a parameter typed as
 * that would force every test to supply one variable it does not care about to
 * exercise one it does.
 */
export interface VitalsEnvironment {
  readonly VITALS_COLLECTOR_URL?: string | undefined;
  readonly VITALS_API_KEY?: string | undefined;
  readonly [key: string]: string | undefined;
}

export function resolveVitalsSink(
  environment: VitalsEnvironment = process.env,
): VitalsSink {
  const url = environment.VITALS_COLLECTOR_URL;
  // Falsy rather than `=== undefined`: `.env.example` ships
  // `VITALS_COLLECTOR_URL=`, which sets the variable to the empty string. It is
  // present, and it is not a URL.
  if (!url) return createLogSink();

  return createHttpSink({ url, token: environment.VITALS_API_KEY });
}
