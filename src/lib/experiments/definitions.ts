/**
 * The experiments this application runs, and the shape one has to have.
 *
 * Written down in one module, for the same reason `@/lib/third-party/catalogue`
 * is: an experiment that exists only as a condition somewhere in a component is
 * an experiment nobody can enumerate, retire, or explain to the person asking
 * why two screenshots of the same page disagree. Everything that decides what a
 * visitor sees — the arms, their shares, where it runs, which URL it rewrites —
 * is here, and `scripts/assert-experiment-wiring.ts` fails the build if the
 * registry and the routes drift apart.
 *
 * `validateRegistry` below is the other half. Every rule it enforces is one
 * that produces a *plausible* experiment rather than a broken one: weights that
 * sum to 9,000 do not throw, they silently hand 10% of traffic to whichever arm
 * is last; a fallback naming a variant that was deleted does not throw either,
 * it serves `undefined` to the router. Both are caught here, at module load and
 * in CI, rather than in an analysis three weeks later.
 */
import { BUCKET_SPACE } from "@/lib/experiments/hash";

/**
 * Ids are `[a-z0-9-]`, 1–40 characters.
 *
 * They travel in a cookie value and in a URL path segment, so the character set
 * is the intersection of what both accept without encoding. Restricting it here
 * is what lets `@/lib/experiments/cookies` parse a cookie with a `split` and no
 * escaping, and what lets `@/lib/experiments/routing` interpolate a variant id
 * into a path without asking whether it needs `encodeURIComponent`.
 */
export const ID_PATTERN = /^[a-z0-9-]{1,40}$/u;

/** ISO 3166-1 alpha-2, as the geo headers report it. */
export const COUNTRY_PATTERN = /^[A-Z]{2}$/u;

export interface ExperimentVariant {
  readonly id: string;
  /**
   * This arm's share of targeted traffic, in basis points. The variants of one
   * experiment must sum to `BUCKET_SPACE`.
   */
  readonly weightBasisPoints: number;
  /** What this arm changes. Printed by the wiring gate when it complains. */
  readonly because: string;
}

/**
 * How an experiment reaches the URL space.
 *
 * The canonical path is a real page — the one a link, a sitemap and a share
 * card point at — and it renders `canonicalVariantId` itself. Every *other*
 * variant lives under `rewritePrefix` and is reached by a proxy rewrite, so the
 * address bar never changes and no variant is linkable by accident.
 *
 * Rewriting rather than redirecting is not a detail. A 302 to `/pricing/v/…`
 * puts the variant in the address bar, in the visitor's history, in the link
 * they paste into a chat, and in whatever your analytics calls a page path —
 * at which point the experiment is visible to the people in it and its arms
 * are indexable by search engines as duplicate content.
 */
export interface ExperimentRoute {
  /** The URL visitors see and link to, e.g. `/pricing`. */
  readonly path: string;
  /**
   * The variant the canonical path renders on its own.
   *
   * This is what makes the feature degrade rather than break: if the proxy is
   * bypassed, disabled, or has not run yet, `/pricing` still answers with a
   * real page, and it is the control arm.
   */
  readonly canonicalVariantId: string;
  /**
   * Where the other variants are served from. A variant id is appended, so
   * `/pricing/v` + `annual-first` is `/pricing/v/annual-first`.
   */
  readonly rewritePrefix: string;
}

export interface Experiment {
  readonly id: string;
  /**
   * Changes the split. See `bucketSeed` in `@/lib/experiments/hash`: a rerun on
   * the same population with the same salt re-uses the previous cohorts.
   *
   * Changing it does **not** move the visitors already assigned — their arm is
   * in their cookie and `@/lib/experiments/assignment` keeps it. That is the
   * intended behaviour and it is worth saying out loud: a salt change starts a
   * new experiment for new visitors, it does not restart the old one for
   * everyone. Restarting for everyone means a new `id`.
   */
  readonly salt: string;
  readonly variants: readonly ExperimentVariant[];
  /**
   * The arm served to traffic the experiment does not target.
   *
   * Not persisted — see `@/lib/experiments/assignment`. Someone outside the
   * targeted countries is not "assigned to control", they are *not in the
   * experiment*, and writing that into their cookie would keep them out of it
   * for a year after they travel.
   */
  readonly fallbackVariantId: string;
  /**
   * Countries the experiment runs in, ISO 3166-1 alpha-2. Omit to run
   * everywhere, including visitors whose country could not be established.
   */
  readonly countries?: readonly string[];
  /** Omit for an experiment that changes no URL. */
  readonly route?: ExperimentRoute;
  /** What this experiment is asking. Printed by the wiring gate. */
  readonly because: string;
}

/**
 * The live registry.
 *
 * One entry. The machinery around it is written for many — the cookie encodes a
 * set, the assignment pass is a fold over the registry, and the tests exercise
 * multi-experiment registries as fixtures — but shipping a second experiment
 * that nothing renders would be shipping dead configuration, and a registry
 * nobody trusts to be current is the failure this module exists to avoid.
 */
export const EXPERIMENTS: readonly Experiment[] = [
  {
    id: "pricing-cta",
    salt: "2026-09-a",
    variants: [
      {
        id: "control",
        weightBasisPoints: 5_000,
        because: "monthly price first, the layout /pricing has always had",
      },
      {
        id: "annual-first",
        weightBasisPoints: 5_000,
        because:
          "annual price first with the monthly equivalent underneath, which is the " +
          "framing the hypothesis is about",
      },
    ],
    fallbackVariantId: "control",
    // Deliberately a short list rather than "the EU" or "English-speaking
    // markets": the annual framing quotes a single currency, and a visitor
    // shown a price in a currency they do not pay in is a worse experience than
    // being left out of the experiment. Widening this list is a content
    // decision before it is a targeting one.
    countries: ["US", "CA", "GB", "IE", "AU", "NZ"],
    route: {
      path: "/pricing",
      canonicalVariantId: "control",
      rewritePrefix: "/pricing/v",
    },
    because:
      "does leading with the annual price move sign-ups, or only move them to the " +
      "cheaper-looking number",
  },
];

export interface RegistryProblem {
  experimentId: string;
  message: string;
}

/**
 * Every way a registry can be wrong that would otherwise look right.
 *
 * Returns problems rather than throwing, so the wiring gate can print all of
 * them at once and the module below can decide separately what to do about
 * them. Pure, and takes the registry as an argument, so the tests can describe
 * a broken registry without editing the live one.
 */
export function validateRegistry(
  experiments: readonly Experiment[],
): RegistryProblem[] {
  const problems: RegistryProblem[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const experiment of experiments) {
    const report = (message: string): void => {
      problems.push({ experimentId: experiment.id, message });
    };

    if (!ID_PATTERN.test(experiment.id)) {
      report(`id ${JSON.stringify(experiment.id)} is not [a-z0-9-]{1,40}`);
    }
    if (seenIds.has(experiment.id)) {
      report("id is declared twice; the second one wins silently");
    }
    seenIds.add(experiment.id);

    if (!ID_PATTERN.test(experiment.salt)) {
      report(`salt ${JSON.stringify(experiment.salt)} is not [a-z0-9-]{1,40}`);
    }

    if (experiment.variants.length < 2) {
      report(
        "has fewer than two variants, so it can produce no comparison at all",
      );
    }

    const seenVariants = new Set<string>();
    let total = 0;
    for (const variant of experiment.variants) {
      if (!ID_PATTERN.test(variant.id)) {
        report(
          `variant id ${JSON.stringify(variant.id)} is not [a-z0-9-]{1,40}`,
        );
      }
      if (seenVariants.has(variant.id)) {
        report(`variant ${variant.id} is declared twice`);
      }
      seenVariants.add(variant.id);

      if (
        !Number.isInteger(variant.weightBasisPoints) ||
        variant.weightBasisPoints < 0
      ) {
        report(
          `variant ${variant.id} has weight ${variant.weightBasisPoints}; ` +
            "weights are non-negative integers in basis points",
        );
      }
      total += variant.weightBasisPoints;
    }

    if (total !== BUCKET_SPACE) {
      report(
        `variant weights sum to ${total}, not ${BUCKET_SPACE}. A short sum leaves ` +
          "buckets above the total unassigned and a long one makes the last arm " +
          "unreachable — neither throws, both quietly change the split",
      );
    }

    if (!seenVariants.has(experiment.fallbackVariantId)) {
      report(
        `fallbackVariantId ${JSON.stringify(experiment.fallbackVariantId)} is not one ` +
          "of its variants, so untargeted traffic is served a variant that does not exist",
      );
    }

    for (const country of experiment.countries ?? []) {
      if (!COUNTRY_PATTERN.test(country)) {
        report(
          `country ${JSON.stringify(country)} is not an uppercase ISO 3166-1 alpha-2 ` +
            "code, so it can never match a normalised geo header and silently " +
            "narrows the experiment",
        );
      }
    }
    if (experiment.countries?.length === 0) {
      report(
        "declares an empty country list, which targets nobody. Omit `countries` " +
          "to run everywhere",
      );
    }

    const { route } = experiment;
    if (route) {
      if (!route.path.startsWith("/") || route.path.endsWith("/")) {
        report(
          `route.path ${JSON.stringify(route.path)} must be an absolute path with no ` +
            "trailing slash",
        );
      }
      if (seenPaths.has(route.path)) {
        report(
          `two experiments both rewrite ${route.path}; the first one wins and the ` +
            "second never runs",
        );
      }
      seenPaths.add(route.path);

      if (!seenVariants.has(route.canonicalVariantId)) {
        report(
          `route.canonicalVariantId ${JSON.stringify(route.canonicalVariantId)} is not ` +
            "one of its variants, so the canonical page renders an arm the experiment " +
            "does not have",
        );
      }
      if (!route.rewritePrefix.startsWith(`${route.path}/`)) {
        report(
          `route.rewritePrefix ${JSON.stringify(route.rewritePrefix)} is not under ` +
            `${route.path}/. Serving a variant from outside the canonical path's own ` +
            "subtree means it inherits a different layout than the control",
        );
      }
    }
  }

  return problems;
}

/**
 * The registry is validated at module load, in every runtime that imports it.
 *
 * Throwing here is deliberate. The failures `validateRegistry` reports do not
 * degrade the application, they *bias* it — a short weight sum quietly hands
 * traffic to the last arm, and the experiment still produces a number, which
 * someone will then act on. A page that fails to render is recoverable; a
 * decision made on a split that was not the split anybody declared is not.
 *
 * CI never reaches this: `scripts/assert-experiment-wiring.ts` runs the same
 * function and prints every problem, rather than the first one.
 */
const registryProblems = validateRegistry(EXPERIMENTS);
if (registryProblems.length > 0) {
  throw new Error(
    `Invalid experiment registry:\n${registryProblems
      .map((problem) => `  ${problem.experimentId}: ${problem.message}`)
      .join("\n")}`,
  );
}

/** The experiment with this id, or `undefined`. */
export function findExperiment(
  id: string,
  experiments: readonly Experiment[] = EXPERIMENTS,
): Experiment | undefined {
  return experiments.find((experiment) => experiment.id === id);
}

/** Whether `variantId` is an arm of `experiment`. */
export function hasVariant(experiment: Experiment, variantId: string): boolean {
  return experiment.variants.some((variant) => variant.id === variantId);
}
