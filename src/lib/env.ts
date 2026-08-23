import { z } from "zod";

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
  PREVIEW_SECRET: z.string().min(32).optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
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
});

const skip = process.env["SKIP_ENV_VALIDATION"] === "1";

const parsed = skip
  ? server.merge(client).safeParse({
      DATABASE_URL:
        "postgresql://placeholder:placeholder@localhost:5432/placeholder",
      NEXTAUTH_SECRET: "placeholder-secret-for-build-validation-only",
      NEXT_PUBLIC_APP_URL:
        process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000",
      ...process.env,
    })
  : server.merge(client).safeParse({
      ...process.env,
      NEXT_PUBLIC_APP_URL: process.env["NEXT_PUBLIC_APP_URL"],
    });

if (!parsed.success) {
  console.error(
    "Invalid environment variables:",
    parsed.error.flatten().fieldErrors,
  );
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
