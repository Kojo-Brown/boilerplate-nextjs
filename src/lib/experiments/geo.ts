/**
 * Where the request says it is from, and how much of that to believe.
 *
 * There is no such thing as reading the country off a `NextRequest`. Next 15
 * removed `request.geo` and Next 16 has not brought it back; the value was
 * always a convenience over a header the hosting platform set, and now the
 * header is the whole interface. So this module is a list of the headers
 * platforms actually write, in a deliberate order, with a rule about which of
 * them a client can forge.
 *
 * ## The forgery question, which is the only interesting part
 *
 * `X-Forwarded-For` has a well-known spoofing problem and
 * `@/lib/rate-limit/client-identity` spends a page on it. Geo headers have the
 * same problem and almost none of the attention, because the consequence looks
 * harmless: someone sends `x-geo-country: US` and sees the US pricing page.
 *
 * It is worth separating the two things that are true about that.
 *
 *  - For **experiment targeting**, self-selection is a nuisance, not a breach.
 *    A visitor who forges their way into an arm skews the arm by one visitor,
 *    which is what the `forced` flag on an override already accounts for.
 *  - For **anything that costs money or is legally geo-scoped** — tax, currency,
 *    export controls, age gates, content licensing — a forgeable header is not
 *    an input at all. Those belong on the server, against a source the caller
 *    does not supply.
 *
 * The rule that falls out: headers a platform *overwrites* are trusted, and a
 * generic header nothing overwrites is trusted only when the deployment says
 * so. Vercel and Cloudflare both strip and rewrite their own headers at the
 * edge, so `x-vercel-ip-country` and `cf-ipcountry` arrive trustworthy or not
 * at all. `x-geo-country` is the escape hatch for every other CDN, and it is
 * off unless `EXPERIMENTS_TRUST_FORWARDED_GEO` is set — because a deployment
 * that reads it without an edge in front of it is reading a value the browser
 * typed.
 */

/** Country code used when nothing usable arrived. */
export const UNKNOWN_COUNTRY = "ZZ";

/**
 * Headers a hosting platform sets and overwrites, in precedence order.
 *
 * Order matters when a request passes through two of them — Cloudflare in front
 * of Vercel is a common shape — and the *innermost* proxy is the one whose
 * header was written last and cannot have been forged by the one outside it.
 * `x-vercel-ip-country` is therefore first.
 */
export const TRUSTED_GEO_HEADERS = [
  "x-vercel-ip-country",
  "cf-ipcountry",
] as const;

/** The header read only when the deployment opts in. */
export const FORWARDED_GEO_HEADER = "x-geo-country";

/** Env var that opts into {@link FORWARDED_GEO_HEADER}. */
export const TRUST_FORWARDED_GEO_ENV = "EXPERIMENTS_TRUST_FORWARDED_GEO";

/**
 * Values that mean "we do not know", spelled as if they were countries.
 *
 * Cloudflare sends `XX` when it cannot geolocate the address and `T1` for
 * traffic arriving over Tor. Both match `/^[A-Z]{2}$/` and both are perfectly
 * capable of being compared against a targeting list, where they would match
 * nothing and quietly exclude the visitor — which is the right outcome, reached
 * by accident. Mapping them to {@link UNKNOWN_COUNTRY} makes it the stated one,
 * and makes "unknown" one value instead of three.
 */
export const NON_COUNTRY_CODES = new Set(["XX", "T1", "ZZ"]);

/** How the country was established. Carried for the log line, not for logic. */
export type GeoSource =
  (typeof TRUSTED_GEO_HEADERS)[number] | "forwarded" | "none";

export interface RequestGeo {
  /** ISO 3166-1 alpha-2, or {@link UNKNOWN_COUNTRY}. */
  readonly country: string;
  readonly source: GeoSource;
}

export const UNKNOWN_GEO: RequestGeo = {
  country: UNKNOWN_COUNTRY,
  source: "none",
};

/**
 * `us` → `US`, `  gb ` → `GB`, `XX` → undefined, `United States` → undefined.
 *
 * Anything that is not two letters is rejected rather than passed through.
 * Passing it through would put an arbitrary caller-supplied string into a
 * comparison against the targeting list and into the exposure header, where it
 * becomes an injection surface for whatever reads that header downstream.
 */
export function normaliseCountry(raw: string): string | undefined {
  const value = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/u.test(value)) return undefined;
  if (NON_COUNTRY_CODES.has(value)) return undefined;
  return value;
}

export interface ReadGeoOptions {
  /**
   * Whether {@link FORWARDED_GEO_HEADER} may be read. Defaults to the env var,
   * resolved per call rather than at module load so a test can change it.
   */
  readonly trustForwarded?: boolean;
}

/**
 * Reads the env opt-in.
 *
 * Deliberately not routed through `@/lib/env`, for the reason
 * `@/lib/rate-limit/client-identity` gives for the same decision: that module
 * validates the whole server schema, and the proxy needs none of it. Any value
 * other than `"1"` or `"true"` is off, including `"false"`, `"no"` and a typo —
 * the fail-safe direction for a switch that widens what the application
 * believes.
 */
export function trustsForwardedGeo(
  raw: string | undefined = process.env[TRUST_FORWARDED_GEO_ENV],
): boolean {
  return raw === "1" || raw === "true";
}

/** The country this request should be treated as coming from. */
export function readGeo(
  headers: Headers,
  options: ReadGeoOptions = {},
): RequestGeo {
  for (const header of TRUSTED_GEO_HEADERS) {
    const raw = headers.get(header);
    if (raw === null) continue;
    const country = normaliseCountry(raw);
    if (country) return { country, source: header };
  }

  const trustForwarded = options.trustForwarded ?? trustsForwardedGeo();
  if (trustForwarded) {
    const raw = headers.get(FORWARDED_GEO_HEADER);
    const country = raw === null ? undefined : normaliseCountry(raw);
    if (country) return { country, source: "forwarded" };
  }

  return UNKNOWN_GEO;
}

/**
 * Whether an experiment's targeting admits this country.
 *
 * `undefined` countries means "everywhere", and everywhere includes
 * {@link UNKNOWN_COUNTRY}. An experiment that lists countries excludes unknown
 * traffic by construction, which is the conservative reading of a list: a
 * visitor we cannot place is not known to be in the market the list describes.
 * On a deployment with no geo header at all that puts *all* traffic in the
 * fallback arm — which is the correct answer to "run this only in these six
 * countries" when the platform cannot tell you the country, and is why
 * `scripts/assert-experiment-wiring.ts` prints the geo source it found.
 */
export function targetsCountry(
  countries: readonly string[] | undefined,
  country: string,
): boolean {
  if (countries === undefined) return true;
  return countries.includes(country);
}
