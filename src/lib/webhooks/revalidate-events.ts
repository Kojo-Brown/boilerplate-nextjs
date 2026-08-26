/**
 * The vocabulary an external CMS speaks to `POST /api/revalidate`, and how it
 * maps onto this application's own cache-invalidation policy.
 *
 * ## Why this is not just `CacheMutation` on the wire
 *
 * `CacheMutation` (`@/lib/cache/invalidation`) carries *observations*:
 * `post.updated` reports `wasPublished` and `isPublished` because the Server
 * Action that reports it had to read one and write the other, so it knows both
 * and cannot be wrong about either. That is exactly what an external sender
 * cannot supply. A CMS knows "this document was published"; it does not know
 * what our database thought a moment ago, and inviting it to tell us would make
 * the invalidation policy a function of a remote system's opinion — including
 * an attacker's, if the secret ever leaks.
 *
 * So the wire vocabulary names *transitions*, one per thing a CMS can do, and
 * {@link mutationFor} fills in the before/after pair each transition implies.
 * The mapping is the only place the two vocabularies meet, which keeps
 * `tagsFor` the single owner of "which tags does that drop" — a webhook that
 * dropped tags of its own would be the drift that
 * `scripts/assert-cache-invalidation.ts` exists to prevent, arriving over HTTP
 * instead of through an import.
 *
 * ## Why every event is a transition of *public* visibility
 *
 * A blog cache entry only changes when a post is visible to the public before
 * or after the change. `post.published`, `post.unpublished` and `post.deleted`
 * are therefore all equally invalidating, and an edit to a draft is not an
 * event this endpoint has anything to do — a CMS that sends one gets a 200 and
 * an empty tag list, which is the honest answer rather than a rejection.
 */
import { z } from "zod";
import type { CacheMutation } from "@/lib/cache/invalidation";

/**
 * The payload schema.
 *
 * A discriminated union rather than a loose `{ event: string }`, so an
 * unrecognised event name is a 422 naming the field rather than a silent no-op.
 * That distinction matters at exactly the moment it is hardest to debug: a CMS
 * misconfigured to send `post.publish` would otherwise get 200s forever while
 * the blog stayed stale.
 */
export const revalidateEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("post.published"),
    /** The post's id, which is also its blog slug — see `generateStaticParams`. */
    postId: z.string().min(1),
  }),
  z.object({
    event: z.literal("post.updated"),
    postId: z.string().min(1),
  }),
  z.object({
    event: z.literal("post.unpublished"),
    postId: z.string().min(1),
  }),
  z.object({
    event: z.literal("post.deleted"),
    postId: z.string().min(1),
  }),
  z.object({
    /**
     * "Something changed that I cannot describe" — the escape hatch every CMS
     * integration eventually needs, and the one a bulk import or a restored
     * backup should send. Drops the list tag, which
     * `getCachedPost` also carries, so it clears every blog entry.
     */
    event: z.literal("blog.refresh"),
  }),
  z.object({
    /**
     * A no-op the sender can use to prove the secret and the URL are right.
     *
     * Every CMS webhook UI has a "send test event" button, and pointing it at a
     * real event means the first thing an integrator does is invalidate
     * production's blog cache. Answering this one with an empty tag list makes
     * the button safe, and makes "did my signature verify?" answerable without
     * side effects.
     */
    event: z.literal("ping"),
  }),
]);

export type RevalidateEvent = z.infer<typeof revalidateEventSchema>;

/** Every event name the endpoint accepts, for the docs and the 422 message. */
export const REVALIDATE_EVENTS: readonly RevalidateEvent["event"][] = [
  "post.published",
  "post.updated",
  "post.unpublished",
  "post.deleted",
  "blog.refresh",
  "ping",
];

/**
 * The mutation an event stands for, or `null` for one that invalidates nothing.
 *
 * The `wasPublished`/`isPublished` pairs below are the substance of this
 * function. Each is the pair the transition implies, not a guess:
 *
 *  - **published** — was not public, is now. Drops both tags, because the list
 *    must start naming it.
 *  - **updated** — public before and after. Still drops both, since
 *    `getCachedPost` and `getCachedPublishedPosts` both hold a copy of the
 *    title. A CMS that sends this for a draft edit is over-reporting, and
 *    over-invalidating costs one cache fill; under-invalidating costs stale
 *    content, so this is the direction to be wrong in.
 *  - **unpublished** — was public, is not. `tagsFor` drops just as much for
 *    this as for a publish, which is the case a naive "is it live now?" check
 *    gets wrong.
 *  - **deleted** — reported as `wasPublished: true` for the same reason:
 *    a CMS deleting a draft is not distinguishable from one deleting a live
 *    post, and only one of those two mistakes leaves a dead page cached.
 */
export function mutationFor(event: RevalidateEvent): CacheMutation | null {
  switch (event.event) {
    case "post.published":
      return {
        kind: "post.updated",
        postId: event.postId,
        wasPublished: false,
        isPublished: true,
      };

    case "post.updated":
      return {
        kind: "post.updated",
        postId: event.postId,
        wasPublished: true,
        isPublished: true,
      };

    case "post.unpublished":
      return {
        kind: "post.updated",
        postId: event.postId,
        wasPublished: true,
        isPublished: false,
      };

    case "post.deleted":
      return {
        kind: "post.deleted",
        postId: event.postId,
        wasPublished: true,
      };

    case "blog.refresh":
      return { kind: "blog.manual-refresh" };

    case "ping":
      return null;
  }
}
