import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // Partial Prerendering. In Next 16 `experimental.ppr` no longer exists — it
  // was merged into Cache Components, which is repo-wide and has no per-route
  // opt-in. See docs/partial-prerendering.md.
  cacheComponents: true,
  // Promoted out of `experimental` in Next 16.
  typedRoutes: true,
  /**
   * `Cache-Control` for the canonical path of every routed experiment.
   *
   * ## What this is protecting against
   *
   * `/pricing` answers with different markup for two requests that differ by
   * nothing but a cookie, and the prerendered response's own header is
   * `s-maxage=31536000` — a year, in a shared cache, keyed on the URL. A CDN in
   * front of this application would store whichever arm the first visitor after
   * a purge happened to get and hand it to everyone behind it, and the
   * experiment would go on reporting a difference between two populations that
   * were never split.
   *
   * ## Why this is not `Vary: Cookie`
   *
   * `Vary: Cookie` is the correct HTTP answer and Next will not let you send
   * it: it writes its own `Vary` on every App Router response — `rsc,
   * next-router-state-tree, next-router-prefetch,
   * next-router-segment-prefetch, Accept-Encoding` — and that value replaces
   * whatever came before it. Verified on a production build, both ways: set
   * from the proxy, on the rewrite's `NextResponse`, where
   * `x-experiment-exposure` arrived intact and `Vary` did not; and set from
   * this block, where a probe header and the `Cache-Control` below both arrived
   * and `Vary` did not. So a `Vary: Cookie` anywhere in this codebase would be
   * a line that reads like a protection and is discarded before it reaches a
   * cache.
   *
   * `private` is the half of the value that matters — a shared cache may not
   * store the response at all. `max-age=0, must-revalidate` lets the browser
   * keep its copy and revalidate against the `ETag` Next already sends, so a
   * repeat visit is a 304 rather than a full document; the arm is stable, so
   * that copy is almost always still right, and a retired experiment is what
   * the revalidation notices.
   *
   * The cost is that the canonical path is no longer served from a CDN edge.
   * One path, a small static document, and the variant pages it rewrites to
   * keep their own long-lived cache entries under their own URLs.
   *
   * These are literals rather than a call into `src/lib/experiments`: this file
   * is compiled to CommonJS by `next typegen` without the `@/` alias, so
   * importing the registry here resolves during `next build` and fails during
   * typegen. `scripts/assert-experiment-wiring.ts` closes the gap the other
   * way — it holds the registry, reads this block, and fails if a routed
   * experiment's canonical path is missing from it or is cacheable by a shared
   * cache. See docs/experiments.md.
   */
  async headers() {
    return [
      {
        source: "/pricing",
        headers: [
          {
            key: "Cache-Control",
            value: "private, max-age=0, must-revalidate",
          },
        ],
      },
    ];
  },
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
      {
        protocol: "https",
        hostname: "**.googleusercontent.com",
      },
    ],
  },
};

export default config;
