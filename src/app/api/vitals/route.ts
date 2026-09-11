import { defineRoute } from "@/lib/api/define-route";
import { rateMetric, vitalsPayloadSchema } from "@/lib/vitals/metric";
import { resolveVitalsSink } from "@/lib/vitals/sink";
import type { VitalsPayload } from "@/lib/vitals/metric";
import type { VitalsEvent } from "@/lib/vitals/sink";

/**
 * The collector for `useReportWebVitals`.
 *
 * One beacon per page view arrives here carrying the final value of every
 * metric the browser managed to measure. The handler's whole job is to decide
 * whether the batch is real, stamp it with what only the server knows, and hand
 * it to the sink.
 *
 * ## Unauthenticated, on purpose
 *
 * The measurements worth having are the ones from a signed-out visitor's first
 * paint, which is before any session exists — so requiring one would collect
 * data from exactly the population whose experience is already good. That makes
 * the body attacker-controlled in the ordinary case, which is why
 * `vitalsPayloadSchema` bounds every field and why the rating below is computed
 * here rather than trusted from the client. The budget in front of it is
 * `TELEMETRY_POLICY` in `@/lib/rate-limit/policy`.
 *
 * ## 202, and 202 even when the sink is down
 *
 * The response is `202 Accepted` because that is what happened: the batch was
 * accepted for delivery, and delivery is not something the caller can wait for
 * or act on. `navigator.sendBeacon` discards the response entirely — there is
 * no client to inform.
 *
 * The consequence, and it is deliberate, is that a sink failure does not become
 * a 5xx. This endpoint is hit once per page view, so a collector outage handled
 * the obvious way would put the application's own error rate through the roof
 * and page whoever is on call — for telemetry. The failure is logged instead,
 * under a marker an alert can select on, so it is visible to the people who
 * care about metrics and invisible to the availability numbers.
 *
 * ## Runtime
 *
 * No `export const runtime` here, and there cannot be one: Cache Components
 * rejects the segment config outright. `/api/vitals` is declared `portable` in
 * `@/lib/api/runtimes` — it reads no database and holds no state, so it is one
 * of the routes that could move in front of the application the day the
 * framework allows it, and `scripts/assert-api-runtimes.ts` is what keeps a
 * convenience import from quietly taking that away.
 */
export interface VitalsAck {
  /** How many metrics the batch contained. Echoed for debugging by hand. */
  accepted: number;
}

export const POST = defineRoute<VitalsAck, undefined, undefined, VitalsPayload>(
  {
    body: vitalsPayloadSchema,
    status: 202,
    handler: async ({ body }) => {
      const receivedAt = new Date().toISOString();

      const events: VitalsEvent[] = body.metrics.map((metric) => ({
        path: body.path,
        metric: rateMetric(metric),
        receivedAt,
      }));

      const sink = resolveVitalsSink();

      try {
        await sink.deliver(events);
      } catch (thrown) {
        // The one place this failure is recorded. `[vitals]` rather than the
        // `[api]` prefix `defineRoute` uses for faults, because this is not a
        // fault of the request — the request was fine and is being answered 202.
        console.error(
          `[vitals] sink "${sink.name}" failed to deliver:`,
          thrown,
        );
      }

      return { accepted: events.length };
    },
  },
);
