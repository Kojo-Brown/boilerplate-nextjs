/**
 * Turning an assignment into a URL, and deciding which requests get one at all.
 *
 * Still pure — strings in, strings out. `@/lib/experiments/edge` is what holds a
 * `NextRequest`.
 */
import {
  hasVariant,
  ID_PATTERN,
  type Experiment,
} from "@/lib/experiments/definitions";
import type { Assignment } from "@/lib/experiments/assignment";

/**
 * Query-parameter prefix for forcing an arm: `?bkt_pricing-cta=annual-first`.
 *
 * A query parameter rather than a header, because the use is "send someone a
 * link to the arm you are looking at" and a header is not something you can put
 * in a link. It is also why the parameter is *not* stripped from the URL before
 * rewriting: the page is served for `/pricing?bkt_pricing-cta=…`, the address
 * bar keeps it, and a reload shows the same arm. Stripping it would make the
 * override survive exactly one render.
 */
export const OVERRIDE_PREFIX = "bkt_";

/**
 * Forced arms in a query string, as `experimentId -> variantId`.
 *
 * Both halves are checked against `ID_PATTERN` here even though
 * `resolveAssignments` checks the variant against the registry anyway: this
 * value reaches a log line and the wiring gate's output before that happens, and
 * "reject anything that is not an id" is a cheaper thing to be sure of than
 * "every consumer downstream escapes correctly".
 */
export function parseOverrides(params: URLSearchParams): Map<string, string> {
  const overrides = new Map<string, string>();

  for (const [key, value] of params) {
    if (!key.startsWith(OVERRIDE_PREFIX)) continue;
    const experimentId = key.slice(OVERRIDE_PREFIX.length);
    if (!ID_PATTERN.test(experimentId)) continue;
    if (!ID_PATTERN.test(value)) continue;
    if (overrides.has(experimentId)) continue;
    overrides.set(experimentId, value);
  }

  return overrides;
}

/**
 * Paths that take part in bucketing at all.
 *
 * Excluding `/api` is not an optimisation. A route handler answers a `fetch`,
 * not a navigation, and a `Set-Cookie` on one of those responses would mint a
 * visitor id for a caller that has no browser to keep it in — so the id would
 * be re-minted on every poll, every health check and every webhook delivery,
 * and the cookie would be pure noise on responses whose whole job is to be
 * cached or piped somewhere. Pages are where a visitor exists.
 *
 * Next's own internals (`/_next`) are already excluded by the proxy's matcher;
 * they are listed here so that this function answers correctly when it is asked
 * directly, which the tests and the wiring gate both do.
 */
export function participates(pathname: string): boolean {
  if (pathname === "/api" || pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/_next/")) return false;
  return true;
}

export interface RewriteDecision {
  readonly experimentId: string;
  readonly variantId: string;
  /** The canonical path, unchanged in the address bar. */
  readonly from: string;
  /** The internal path that actually renders. */
  readonly to: string;
}

/**
 * The internal path for a variant, e.g. `/pricing/v/annual-first`.
 *
 * No `encodeURIComponent`: `ID_PATTERN` is `[a-z0-9-]`, and `validateRegistry`
 * rejects anything else at module load, so there is nothing an encode would
 * change. Reaching for one anyway would imply the ids are untrusted, which
 * would be the wrong thing for a reader to conclude about a value that comes
 * from a checked-in file.
 */
export function variantPath(experiment: Experiment, variantId: string): string {
  const prefix = experiment.route?.rewritePrefix ?? "";
  return `${prefix}/${variantId}`;
}

/**
 * The rewrite this request needs, or `undefined` for the overwhelming majority
 * of requests, which need none.
 *
 * Three ways to get `undefined`, and the second is the one that makes this
 * feature degrade instead of break:
 *
 *  - the path is not an experiment's canonical path;
 *  - the assigned arm is the canonical one, which the canonical page already
 *    renders. So `/pricing` serves its own page for half the traffic, and for
 *    *all* the traffic if the proxy never runs — a control arm, rather than a
 *    404 or a blank;
 *  - the assignment names an arm the experiment does not have, which
 *    `resolveAssignments` will not produce and which is checked anyway, because
 *    the cost of being wrong here is a rewrite to a path that does not exist.
 */
export function resolveRewrite(
  pathname: string,
  assignments: readonly Assignment[],
  experiments: readonly Experiment[],
): RewriteDecision | undefined {
  for (const experiment of experiments) {
    const { route } = experiment;
    if (!route || route.path !== pathname) continue;

    const assignment = assignments.find(
      (candidate) => candidate.experimentId === experiment.id,
    );
    if (!assignment) return undefined;
    if (assignment.variantId === route.canonicalVariantId) return undefined;
    if (!hasVariant(experiment, assignment.variantId)) return undefined;

    return {
      experimentId: experiment.id,
      variantId: assignment.variantId,
      from: pathname,
      to: variantPath(experiment, assignment.variantId),
    };
  }

  return undefined;
}
