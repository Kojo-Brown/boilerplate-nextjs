/**
 * Every secret this application reads, validated once, behind a marker that
 * makes importing it from a browser a build error.
 *
 * `server-only` is a package with no exports and one job: Next aliases it to a
 * module that throws when it is compiled into a *client* bundle, and to an empty
 * module everywhere else. So the import below is not a hint or a convention —
 * it is the enforcement. Any `"use client"` module that reaches this file, at
 * any depth, fails `next build` with the chain that got it there.
 *
 * It replaces a runtime failure with a build failure, and that is the whole
 * value. Without it such an import compiles and ships, and what stops the secret
 * being readable is only that it was never there: Next substitutes literals for
 * `NEXT_PUBLIC_*` names and nothing else, so the schema below would find the
 * secrets missing and throw in the visitor's browser instead — which is the
 * mechanism `docs/draft-mode.md` was relying on before this import existed.
 * Nothing leaks that way, and nothing is checked either.
 *
 * `docs/server-only.md` has the reasoning, the measurement, and the two holes the
 * marker cannot see.
 */
import "server-only";

import { z } from "zod";

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

/**
 * The keys above whose value is key material or a credential, as opposed to
 * configuration that merely happens to be server-side.
 *
 * Both enforcement paths read this list — `scripts/assert-server-only.ts` off
 * the source text, the `server-only/no-secret-env-access` ESLint rule off the
 * same literal — and neither can read a judgement that only exists in someone's
 * head, which is why the distinction is written down here rather than inferred
 * from the name. `AWS_REGION` is server-side and public; `AWS_SECRET_ACCESS_KEY`
 * is neither.
 *
 * `DATABASE_URL` is in the list because a Postgres URL carries its password in
 * the authority. `NEXTAUTH_URL` is not: it is an origin, published on every
 * response.
 *
 * `src/lib/env/server.test.ts` asserts every name here is a key of the schema
 * above, so a rename cannot quietly empty the list the two gates work from.
 */
export const SECRET_KEYS = [
  "DATABASE_URL",
  "NEXTAUTH_SECRET",
  "PREVIEW_SECRET",
  "REVALIDATE_SECRET",
  "VITALS_API_KEY",
  "GOOGLE_CLIENT_SECRET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
] as const;

const skip = process.env["SKIP_ENV_VALIDATION"] === "1";

const parsed = skip
  ? server.safeParse({
      DATABASE_URL:
        "postgresql://placeholder:placeholder@localhost:5432/placeholder",
      NEXTAUTH_SECRET: "placeholder-secret-for-build-validation-only",
      ...process.env,
    })
  : server.safeParse(process.env);

if (!parsed.success) {
  console.error(
    "Invalid environment variables:",
    parsed.error.flatten().fieldErrors,
  );
  throw new Error("Invalid environment variables");
}

/**
 * `NEXTAUTH_URL` has a default, and in production a default is worse than a
 * failure.
 *
 * The schema above falls back to `http://localhost:3000`, which is right for a
 * fresh clone and wrong for every deployment. It is wrong in a way that does
 * not announce itself, because `@/lib/auth/deployment` pins Auth.js's origin to
 * this value and derives the cookie's `Secure` flag and `__Host-` prefix from
 * its scheme: an unset variable in production would mean session cookies issued
 * without `Secure`, for an origin nobody is browsing, and a sign-in that
 * redirects to localhost. Refusing to boot is the only outcome an operator
 * cannot fail to notice.
 *
 * Checked here rather than as a schema refinement so that it applies only at a
 * real boot. `SKIP_ENV_VALIDATION=1` is how the Dockerfile compiles the app
 * without a runtime environment at all, and a build has no deployment URL to
 * know yet — the container it produces does, and reaches this line when it
 * starts. `AUTH_URL` satisfies it too, since that is Auth.js's own name for the
 * same setting and `@/lib/auth/deployment` honours it first.
 */
if (
  !skip &&
  parsed.data.NODE_ENV === "production" &&
  process.env["NEXTAUTH_URL"] === undefined &&
  process.env["AUTH_URL"] === undefined
) {
  throw new Error(
    "NEXTAUTH_URL (or AUTH_URL) must be set in production: it is the origin " +
      "session cookies, callbacks and redirects are issued for, and its " +
      "scheme decides whether those cookies are marked Secure.",
  );
}

export const serverEnv = parsed.data;
