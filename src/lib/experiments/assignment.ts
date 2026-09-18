/**
 * Which arm of which experiment a visitor is in, and why.
 *
 * Pure: it takes a registry, a visitor id, a country and whatever was in the
 * cookie, and returns assignments. No request, no response, no clock. Everything
 * that touches `NextRequest` lives in `@/lib/experiments/edge`, which is what
 * makes the interesting half of this feature testable without constructing one.
 *
 * ## The order of precedence, and what each step is protecting
 *
 * 1. **An override** (`?bkt_pricing-cta=annual-first`) wins, and is never
 *    persisted. It exists so a reviewer can open both arms in two tabs without
 *    clearing cookies, and so a bug report can name the arm it was seen in.
 *    Because anyone can send one, an overridden assignment is marked
 *    `exposed: false` and kept out of the exposure header — a link that forces
 *    an arm can then skew a visitor's experience, which is the point, and not
 *    the numbers, which is not.
 *
 * 2. **The cookie** wins next, even against targeting. A visitor who was
 *    bucketed in a targeted country and is now somewhere else keeps their arm:
 *    they have already seen it, and moving them would make one person's data
 *    span both arms. The only cookie entry that is discarded is one naming a
 *    variant the experiment no longer has.
 *
 * 3. **Targeting** decides whether the visitor is in the experiment at all.
 *    Failing it yields the fallback arm with `exposed: false` — not in the
 *    experiment, not counted, and deliberately *not written to the cookie*, so
 *    that the same visitor is reconsidered the next time they arrive rather
 *    than pinned to the fallback for a year by a trip abroad.
 *
 * 4. **The hash** buckets everyone else, and that result is persisted.
 */
import {
  hasVariant,
  type Experiment,
  type ExperimentVariant,
} from "@/lib/experiments/definitions";
import { targetsCountry } from "@/lib/experiments/geo";
import { bucketSeed, hashToBucket } from "@/lib/experiments/hash";

/**
 * How a visitor came to be in an arm.
 *
 * `cookie` and `hash` are the two that persist. The distinction between them is
 * not cosmetic — it is the difference between "this is where they have been"
 * and "this is where they land today", and the reconciliation in
 * `resolveAssignments` is the only place that can tell.
 */
export type AssignmentSource = "override" | "cookie" | "targeting" | "hash";

export interface Assignment {
  readonly experimentId: string;
  readonly variantId: string;
  readonly source: AssignmentSource;
  /**
   * Whether this counts as a measurement.
   *
   * False for an override (self-selected) and for a targeting fallback (not in
   * the experiment). `@/lib/experiments/edge` reports only exposed assignments,
   * so an analytics pipeline reading the exposure header never has to know
   * these rules.
   */
  readonly exposed: boolean;
}

/**
 * The arm whose weight range contains `bucket`.
 *
 * Half-open intervals accumulated in declaration order: an arm weighted 0 is
 * skipped rather than given the single bucket a `<=` comparison would hand it,
 * which is what makes "ramp this arm down to zero" mean zero.
 *
 * Returns the last arm if the weights somehow do not cover the space — which
 * `validateRegistry` makes unreachable, and which is still worth answering,
 * because the alternative is `undefined` flowing into a URL.
 */
export function selectVariant(
  variants: readonly ExperimentVariant[],
  bucket: number,
): ExperimentVariant | undefined {
  let ceiling = 0;
  for (const variant of variants) {
    ceiling += variant.weightBasisPoints;
    if (bucket < ceiling) return variant;
  }
  return variants[variants.length - 1];
}

export interface ResolveOptions {
  readonly experiments: readonly Experiment[];
  readonly visitorId: string;
  readonly country: string;
  /** What the assignment cookie held, already parsed. */
  readonly existing: ReadonlyMap<string, string>;
  /** Forced arms, by experiment id. Never persisted. */
  readonly overrides?: ReadonlyMap<string, string>;
}

/** One assignment per experiment in the registry, in registry order. */
export function resolveAssignments(options: ResolveOptions): Assignment[] {
  const { experiments, visitorId, country, existing } = options;
  const overrides = options.overrides ?? new Map<string, string>();

  return experiments.map((experiment) => {
    const forced = overrides.get(experiment.id);
    if (forced !== undefined && hasVariant(experiment, forced)) {
      return {
        experimentId: experiment.id,
        variantId: forced,
        source: "override",
        exposed: false,
      };
    }

    const remembered = existing.get(experiment.id);
    if (remembered !== undefined && hasVariant(experiment, remembered)) {
      return {
        experimentId: experiment.id,
        variantId: remembered,
        source: "cookie",
        exposed: true,
      };
    }

    if (!targetsCountry(experiment.countries, country)) {
      return {
        experimentId: experiment.id,
        variantId: experiment.fallbackVariantId,
        source: "targeting",
        exposed: false,
      };
    }

    const bucket = hashToBucket(
      bucketSeed(visitorId, experiment.id, experiment.salt),
    );
    const variant = selectVariant(experiment.variants, bucket);

    return {
      experimentId: experiment.id,
      variantId: variant?.id ?? experiment.fallbackVariantId,
      source: "hash",
      exposed: true,
    };
  });
}

/** Sources whose assignment is written back to the cookie. */
const PERSISTED_SOURCES: ReadonlySet<AssignmentSource> = new Set([
  "cookie",
  "hash",
]);

/**
 * The assignments that belong in the cookie, in registry order.
 *
 * Deriving this from the resolved list rather than collecting it during
 * resolution keeps the rule in one readable place, and keeps it honest: an
 * assignment is persisted because of where it came from, not because of where
 * in the function it was created.
 */
export function persistableAssignments(
  assignments: readonly Assignment[],
): [string, string][] {
  return assignments
    .filter((assignment) => PERSISTED_SOURCES.has(assignment.source))
    .map((assignment) => [assignment.experimentId, assignment.variantId]);
}

/**
 * Whether the cookie has to be rewritten.
 *
 * `Set-Cookie` on a response is not free: it is a header on every page view, and
 * on a shared cache it is a reason not to store the response at all. Comparing
 * against what arrived means the cookie is written on the first visit, when an
 * experiment is added or retired, and on no other request.
 *
 * Order-sensitive on purpose — `persistableAssignments` emits registry order, so
 * two sets that differ only in order came from different registries, and
 * rewriting is the cheaper answer than deciding whether that matters.
 */
export function assignmentsChanged(
  persisted: readonly (readonly [string, string])[],
  existing: ReadonlyMap<string, string>,
): boolean {
  if (persisted.length !== existing.size) return true;
  let index = 0;
  for (const [experimentId, variantId] of existing) {
    const entry = persisted[index];
    index += 1;
    if (!entry) return true;
    if (entry[0] !== experimentId || entry[1] !== variantId) return true;
  }
  return false;
}
