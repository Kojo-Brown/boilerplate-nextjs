import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
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
