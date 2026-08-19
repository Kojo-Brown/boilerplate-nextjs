import { defineRoute } from "@/lib/api/define-route";
import { detectRuntime } from "@/lib/api/runtimes";
import type { ApiRuntime } from "@/lib/api/runtimes";

/**
 * Liveness probe, and the repository's running proof of which runtime served a
 * request.
 *
 * `runtime` is read from the executing environment rather than from
 * `API_ROUTES`, so this endpoint disagrees with the declaration when the
 * declaration is wrong — which is the only way an endpoint like this is worth
 * anything. The build-time half of the same question is
 * `scripts/assert-api-runtimes.ts`.
 *
 * There is no `export const runtime` here, and there cannot be: Cache
 * Components rejects the segment config outright. See `src/lib/api/runtimes.ts`.
 */
export interface HealthPayload {
  status: "ok";
  /** The runtime that actually executed this handler. */
  runtime: ApiRuntime;
  /** ISO 8601, so a caller can spot a clock-skewed or cached response. */
  time: string;
}

export const GET = defineRoute<HealthPayload>({
  handler: () => ({
    status: "ok",
    runtime: detectRuntime(),
    time: new Date().toISOString(),
  }),
});
