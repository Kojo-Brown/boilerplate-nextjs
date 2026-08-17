/**
 * The photo catalogue behind `/photos`, `/photos/[id]` and the intercepted
 * modal at `@modal/(.)photos/[id]`.
 *
 * It is a plain in-repo module rather than a Prisma table on purpose. The
 * feature this data exists to demonstrate is *routing* — a detail view that
 * renders as a modal over the gallery on a soft navigation and as a full page
 * on a hard one — and a database read would drag `cacheComponents` semantics,
 * a seeded CI database and a `"use cache"` wrapper into a change that is not
 * about any of those. Static data keeps both routes prerenderable, so
 * `scripts/assert-route-shape.ts` can assert them as `static`/`prebuilt` and a
 * regression in the routing shows up as a route-shape failure rather than as a
 * slow page.
 *
 * The three image sources are the ones `/images` already ships. New Unsplash
 * IDs are not added here casually: nothing in the build fetches them, so a
 * wrong ID is a 404 in the browser that no gate would catch. Adding a photo is
 * one entry in `PHOTOS` plus a verified `source`.
 */

/** The origin declared in `next.config.ts` under `images.remotePatterns`. */
const IMAGE_HOST = "https://images.unsplash.com";

/**
 * Every photo is requested and laid out at 3:2. The sources are not all
 * natively 3:2 — the detail and grid views both use `object-cover`, so the
 * declared box crops rather than distorts.
 */
export const PHOTO_WIDTH = 1600;
export const PHOTO_HEIGHT = 1067;

export interface Photo {
  /**
   * The URL segment, and therefore the shareable identity of the photo. A
   * human-readable slug rather than the upstream asset ID: `/photos/ocean-at-
   * sunset` survives swapping the image source, `/photos/photo-1542281286…`
   * does not.
   */
  id: string;
  title: string;
  /** Describes the image for screen readers; deliberately not the title again. */
  alt: string;
  /** One sentence of context, shown under the image in both views. */
  caption: string;
  /** Upstream asset ID, appended to `IMAGE_HOST`. */
  source: string;
}

export const PHOTOS: readonly Photo[] = [
  {
    id: "mountain-golden-hour",
    title: "Mountain, golden hour",
    alt: "Mountain landscape at golden hour",
    caption:
      "Low side-lighting across a ridge — the widest tonal range in the set, and the one worth opening full size.",
    source: "photo-1506905925346-21bda4d32df4",
  },
  {
    id: "ocean-at-sunset",
    title: "Ocean at sunset",
    alt: "Ocean waves at sunset",
    caption:
      "Breaking water under a low sun. Mostly mid-tones, which is what makes a blur placeholder read convincingly here.",
    source: "photo-1542281286-9e0a16bb7366",
  },
  {
    id: "stars-over-the-range",
    title: "Stars over the range",
    alt: "Stars over a snowy mountain range",
    caption:
      "A night exposure over snow. Almost entirely shadow, so it is the honest test of how a placeholder behaves on a dark image.",
    source: "photo-1519681393784-d120267933ba",
  },
];

/**
 * The optimised source URL for a photo.
 *
 * `next/image` re-encodes and resizes this itself; the `w`/`q` parameters bound
 * what is fetched from upstream in the first place, so the optimiser is not
 * handed a 5 MB original to downscale on every cold cache.
 */
export function photoSrc(photo: Photo, width: number = PHOTO_WIDTH): string {
  return `${IMAGE_HOST}/${photo.source}?w=${width}&q=80`;
}

/** `undefined` for an unknown ID — callers are expected to `notFound()`. */
export function getPhotoById(id: string): Photo | undefined {
  return PHOTOS.find((photo) => photo.id === id);
}

/** Every photo ID, for `generateStaticParams` on both photo routes. */
export function getPhotoIds(): string[] {
  return PHOTOS.map((photo) => photo.id);
}
