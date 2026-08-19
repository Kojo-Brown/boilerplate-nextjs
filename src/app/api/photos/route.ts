import { z } from "zod";
import { defineRoute } from "@/lib/api/define-route";
import { PHOTO_WIDTH, photoSrc, searchPhotos } from "@/lib/photos";
import type { Photo } from "@/lib/photos";

/**
 * The catalogue behind `/photos`, as JSON.
 *
 * This is the repository's worked example of a route whose module graph is
 * genuinely portable: it imports `@/lib/photos` — a plain in-repo module — and
 * `defineRoute`, which is itself limited to `next/server` and the Fetch API.
 * No Prisma, no `node:` built-in, nothing that would pin it to one runtime.
 * `scripts/assert-api-runtimes.ts` asserts that from the build's dependency
 * trace, so the claim fails CI the day someone adds a database read here
 * instead of aging quietly into a lie.
 *
 * It cannot actually *be* deployed to the edge today — Cache Components forbids
 * the segment config that would say so. See `src/lib/api/runtimes.ts`.
 */

/** Bounded so a caller cannot ask for an unbounded response. */
const MAX_LIMIT = 50;

const querySchema = z.object({
  /** Free-text search over title, caption and alt text. */
  q: z.string().trim().max(100).optional(),
  /**
   * `z.coerce` because a query string has no numbers in it. Without the
   * coercion the schema would reject every request that passed a limit at all,
   * which is the kind of failure that only shows up once someone uses the
   * parameter.
   */
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(MAX_LIMIT),
});

/**
 * Not `Photo`. `source` is an upstream asset ID that is only meaningful when
 * concatenated with the image host, so the API resolves it into a `src` a
 * client can use directly and does not leak the internal field.
 */
export interface PhotoResource {
  id: string;
  title: string;
  alt: string;
  caption: string;
  src: string;
}

export interface PhotoListPayload {
  items: PhotoResource[];
  /** Matches before `limit` was applied, so a client can tell it truncated. */
  total: number;
}

function toResource(photo: Photo): PhotoResource {
  return {
    id: photo.id,
    title: photo.title,
    alt: photo.alt,
    caption: photo.caption,
    src: photoSrc(photo, PHOTO_WIDTH),
  };
}

export const GET = defineRoute<PhotoListPayload, z.infer<typeof querySchema>>({
  query: querySchema,
  handler: ({ query }) => {
    const matches = searchPhotos(query.q);
    return {
      items: matches.slice(0, query.limit).map(toResource),
      total: matches.length,
    };
  },
});
