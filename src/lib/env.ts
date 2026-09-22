import { z } from "zod";
import { disableZodJitInBrowser } from "@/lib/security/zod-jitless";

/**
 * Before any schema below it, and that position is the point.
 *
 * This module is in the client graph — `NEXT_PUBLIC_*` is validated in the
 * browser too — so the `z.object()` calls below construct Zod's JIT object
 * validator there, and constructing one probes for `eval` with
 * `new Function("")`. Under the Content Security Policy that throw is refused;
 * Zod catches it and falls back, so nothing breaks, but the browser reports a
 * `script-src` violation on every page load that is indistinguishable from a real
 * one. Zod reads the capability when the schema is built and memoises it, so a
 * call below the schemas would configure nothing. See
 * `@/lib/security/zod-jitless` and docs/csp.md; `scripts/assert-csp.ts` checks
 * both the call and its position.
 */
disableZodJitInBrowser();

/**
 * An optional secret, as it actually arrives from a `.env` file.
 *
 * `z.string().min(32).optional()` is the obvious spelling and it is wrong here.
 * A `.env` line with no value (`PREVIEW_SECRET=`) sets the variable to the
 * *empty string*, which is present — so `.optional()` never applies, `.min(32)`
 * rejects it, and the process refuses to boot with
 * `Invalid environment variables`. `.env.example` ships exactly that line for
 * every optional secret and `README.md` opens with `cp .env.example .env`, so
 * the documented first step of setting this project up did not produce a
 * working environment. (Found while adding `REVALIDATE_SECRET`, which would
 * have been the third variable with the defect.)
 *
 * Preprocessing an empty string to `undefined` is the right fix rather than
 * relaxing the length: "unset" and "set to something too short to be a key" are
 * genuinely different, and only the first is allowed.
 */
const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(32).optional(),
);

const server = z.object({
  DATABASE_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(32),
  NEXTAUTH_URL: z.string().url().default("http://localhost:3000"),
  // Signing key for CMS preview links. Optional: when it is absent the preview
  // signer derives its key from NEXTAUTH_SECRET via HKDF, so no deployment has
  // to set a second secret to use draft mode and no key material is shared
  // between the two. Set it to rotate preview links independently of sessions,
  // or to hand the preview signer to a CMS without handing over the session
  // signer. See src/lib/preview/token.ts and docs/draft-mode.md.
  //
  // 32 characters for the same reason NEXTAUTH_SECRET requires them: it is the
  // input to an HMAC-SHA256 key, and a shorter one is a shorter key.
  PREVIEW_SECRET: optionalSecret,
  // Signing key for the on-demand revalidation webhook. Optional on the same
  // terms as PREVIEW_SECRET: absent, the webhook signer derives its key from
  // NEXTAUTH_SECRET via HKDF with its own domain separator, so no key material
  // is shared with sessions or preview links. Set it to hand a CMS a secret
  // that revalidates and nothing else. See src/lib/webhooks/signature.ts and
  // docs/on-demand-revalidation.md.
  REVALIDATE_SECRET: optionalSecret,
  // Where Web Vitals batches are forwarded. Optional, and unset is the
  // supported default rather than "disabled": absent, `resolveVitalsSink`
  // selects the log sink, which writes one JSON line per metric to stdout and
  // is queryable on every platform that collects it. Set it to an ingest URL to
  // forward instead. See src/lib/vitals/sink.ts and docs/web-vitals.md.
  //
  // Validated as a URL because a typo here is otherwise a `fetch` that throws
  // once per page view, caught and logged by the route handler, with metrics
  // silently going nowhere.
  VITALS_COLLECTOR_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),
  // Bearer token for that collector. Not `optionalSecret`: a collector's ingest
  // key is whatever length that vendor mints, and refusing to boot because
  // someone's key is 24 characters would be this repository inventing a rule
  // for a credential it does not issue.
  VITALS_API_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().optional(),
  ),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Extra origins allowed to post Server Actions, comma-separated. Empty in
  // every ordinary deployment: the check in src/lib/actions/origin.ts accepts
  // the request's own host, which is what a browser sends. This is the escape
  // hatch for a proxy that rewrites neither `host` nor `x-forwarded-host`, and
  // it is the reason `serverActions.allowedOrigins` stays unset in
  // next.config.ts — one list rather than two that drift.
  //
  // Not `optionalSecret`: this is a configuration list, not key material, so
  // there is no minimum length to enforce. Entries may be full origins
  // (`https://app.example.com`) or bare hosts (`app.example.com:8443`);
  // `parseAllowedOrigins` normalises both and drops anything malformed rather
  // than refusing to boot over a typo in an escape hatch.
  ALLOWED_ACTION_ORIGINS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().optional(),
  ),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  // S3-compatible storage (optional — upload feature disabled when absent)
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().default("us-east-1"),
  S3_BUCKET_NAME: z.string().optional(),
});

const client = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  // The site domain registered with Plausible, and the switch that decides
  // whether any analytics script is mounted at all. Absent — which is every
  // fresh clone, every CI build and every preview deployment — nothing is
  // loaded and no request leaves the browser for a vendor. See
  // src/lib/third-party/catalogue.ts and docs/third-party-scripts.md.
  //
  // A bare domain (`example.com`), not a URL: it is the site identifier
  // Plausible matches on, not somewhere anything is fetched from, so
  // `z.string().url()` would reject the value the vendor actually issues. The
  // empty-string preprocessing is the same one `optionalSecret` needs and for
  // the same reason — `NEXT_PUBLIC_PLAUSIBLE_DOMAIN=` in a `.env` file sets it
  // to `""`, which is present, and `""` would otherwise mount the script with
  // an empty `data-domain` and report every page view under no site at all.
  NEXT_PUBLIC_PLAUSIBLE_DOMAIN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().optional(),
  ),
});

const skip = process.env["SKIP_ENV_VALIDATION"] === "1";

const parsed = skip
  ? server.merge(client).safeParse({
      DATABASE_URL:
        "postgresql://placeholder:placeholder@localhost:5432/placeholder",
      NEXTAUTH_SECRET: "placeholder-secret-for-build-validation-only",
      NEXT_PUBLIC_APP_URL:
        process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000",
      NEXT_PUBLIC_PLAUSIBLE_DOMAIN: process.env["NEXT_PUBLIC_PLAUSIBLE_DOMAIN"],
      ...process.env,
    })
  : server.merge(client).safeParse({
      ...process.env,
      NEXT_PUBLIC_APP_URL: process.env["NEXT_PUBLIC_APP_URL"],
      // Spelled out for the same reason as the line above: `process.env` is not
      // an object in a client bundle, it is a set of literals Next substitutes
      // at build time, and only the keys written out like this survive the
      // substitution. The spread covers the server, this covers the browser.
      NEXT_PUBLIC_PLAUSIBLE_DOMAIN: process.env["NEXT_PUBLIC_PLAUSIBLE_DOMAIN"],
    });

if (!parsed.success) {
  console.error(
    "Invalid environment variables:",
    parsed.error.flatten().fieldErrors,
  );
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
