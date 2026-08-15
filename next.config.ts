import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // Partial Prerendering. In Next 16 `experimental.ppr` no longer exists — it
  // was merged into Cache Components, which is repo-wide and has no per-route
  // opt-in. See docs/partial-prerendering.md.
  cacheComponents: true,
  // Promoted out of `experimental` in Next 16.
  typedRoutes: true,
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
