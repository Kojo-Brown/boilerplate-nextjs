/**
 * Low Quality Image Placeholder (LQIP) utilities for next/image.
 *
 * Usage with shimmer (default, no extra deps):
 *   <BlurImage src="..." blurDataURL={shimmerDataUrl(700, 475)} />
 *
 * Usage with real LQIP via `plaiceholder` (install separately):
 *   import { getPlaiceholder } from "plaiceholder";
 *   const { base64 } = await getPlaiceholder("https://example.com/image.jpg");
 *   <BlurImage src="..." blurDataURL={base64} />
 */

function toBase64(str: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str).toString("base64");
  }
  return btoa(str);
}

/**
 * Generates a shimmer SVG gradient as a base64 data URL.
 * Pass this as `blurDataURL` on BlurImage for a placeholder
 * that animates (via the wrapper's CSS pulse) while the image loads.
 */
export function shimmerDataUrl(width: number, height: number): string {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="100%" height="100%" fill="#e2e8f0"/>`,
    `<rect width="100%" height="100%" fill="url(#g)"/>`,
    `<defs>`,
    `<linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="0%">`,
    `<stop offset="0%" stop-color="#e2e8f0"/>`,
    `<stop offset="50%" stop-color="#f8fafc"/>`,
    `<stop offset="100%" stop-color="#e2e8f0"/>`,
    `</linearGradient>`,
    `</defs>`,
    `</svg>`,
  ].join("");

  return `data:image/svg+xml;base64,${toBase64(svg)}`;
}
