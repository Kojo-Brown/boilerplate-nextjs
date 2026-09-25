import { z } from "zod";
import { disableZodJitInBrowser } from "@/lib/security/zod-jitless";

/**
 * The half of the environment a browser is allowed to see, and the reason the
 * other half lives in a different file.
 *
 * One module validating both halves cannot be marked `server-only`, because the
 * `NEXT_PUBLIC_*` values are read in the browser; and left unmarked it puts the
 * names of every secret one import away from a client component. So the schema
 * is split by audience rather than by subject: this file is importable from
 * anywhere, `./server` is importable from a Server Component, a Server Action,
 * a route handler or the proxy, and `next build` is what enforces the
 * difference. See docs/server-only.md.
 *
 * Only `NEXT_PUBLIC_*` keys belong here. Next substitutes those into the client
 * bundle as literals; every other name is simply absent in a browser, so
 * validating one here would either fail or — worse — pass with `undefined`.
 */

/**
 * Before any schema below it, and that position is the point.
 *
 * This module is in the client graph, so the `z.object()` call below constructs
 * Zod's JIT object validator in the browser too, and constructing one probes for
 * `eval` with `new Function("")`. Under the Content Security Policy that throw
 * is refused; Zod catches it and falls back, so nothing breaks, but the browser
 * reports a `script-src` violation on every page load that is indistinguishable
 * from a real one. Zod reads the capability when the schema is built and
 * memoises it, so a call below the schema would configure nothing. See
 * `@/lib/security/zod-jitless` and docs/csp.md; `scripts/assert-csp.ts` checks
 * both the call and its position.
 */
disableZodJitInBrowser();

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
  // empty-string preprocessing is the same one the optional secrets in
  // `./server` need and for the same reason — `NEXT_PUBLIC_PLAUSIBLE_DOMAIN=` in
  // a `.env` file sets it to `""`, which is present, and `""` would otherwise
  // mount the script with an empty `data-domain` and report every page view
  // under no site at all.
  NEXT_PUBLIC_PLAUSIBLE_DOMAIN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().optional(),
  ),
});

/**
 * Spelled out key by key, with no spread of `process.env`.
 *
 * `process.env` is not an object in a client bundle — it is a set of literals
 * Next substitutes at build time — so only the keys written out like this
 * survive the substitution. A spread compiles and yields nothing, which is a
 * schema of defaults that validates successfully and reports no configuration
 * at all.
 */
const parsed = client.safeParse({
  NEXT_PUBLIC_APP_URL: process.env["NEXT_PUBLIC_APP_URL"],
  NEXT_PUBLIC_PLAUSIBLE_DOMAIN: process.env["NEXT_PUBLIC_PLAUSIBLE_DOMAIN"],
});

if (!parsed.success) {
  console.error(
    "Invalid public environment variables:",
    parsed.error.flatten().fieldErrors,
  );
  throw new Error("Invalid public environment variables");
}

export const clientEnv = parsed.data;
