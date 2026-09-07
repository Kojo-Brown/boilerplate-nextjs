/**
 * The events a mutation may record, and the schema each one is read back
 * through.
 *
 * ## Why these are domain facts and not cache instructions
 *
 * The only consumer today is cache invalidation, so the tempting shape is to
 * store a `CacheMutation` directly and skip this module. The reason not to is
 * that an outbox row outlives the code that wrote it: it is written by one
 * deployment and read by the next, possibly minutes later, possibly by a
 * consumer that did not exist when it was written. A row saying "drop
 * blog:posts" can only ever mean that; a row saying "post 7 was published" can
 * be read by the search indexer added next month without rewriting the
 * producers.
 *
 * The mapping into the cache policy is `cacheMutationFor`, one switch, so the
 * separation costs a function and buys the ability to add a second consumer
 * without touching a single mutation. `@/lib/cache/invalidation` remains the
 * only place that decides which tags a fact drops.
 *
 * ## Why every payload has a schema
 *
 * Because the column is `Json`, and JSON is not the value that went into it.
 * `IdempotencyKey.result` learned this the expensive way — a `Date` stored and
 * read back as a string breaks only on the replay path — and the outbox is
 * worse in one specific respect: the relay reads rows that nobody is waiting
 * for, in a process with no user in front of it, so a payload that is subtly
 * the wrong shape produces a background failure rather than a visible one.
 *
 * Parsing on the way out also gives the relay something it must have: a way to
 * tell "this will never work" from "this did not work this time". A payload
 * that does not parse cannot be fixed by retrying it — it is dead-lettered on
 * the first attempt rather than after eight.
 */
import { z } from "zod";
import type { CacheMutation } from "@/lib/cache/invalidation";

/**
 * Every event type, in one list.
 *
 * Exported so the relay can name the ones it understands in an error message,
 * and so a test can assert that the union below and this list agree — two
 * spellings of the same set is how a type gets added to one and not the other.
 */
export const OUTBOX_EVENT_TYPES = [
  "post.created",
  "post.updated",
  "post.deleted",
] as const;

export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

/**
 * A post id as it comes back out of the payload column.
 *
 * Bounded rather than a bare string: this value ends up inside a cache tag, and
 * a tag is a key in a store shared with every other tag the application mints.
 */
const postId = z.string().min(1).max(64);

/**
 * The events.
 *
 * A discriminated union on `type` rather than a schema per type in a lookup
 * table, so that `outboxEventSchema.safeParse` is one call and the failure it
 * reports for an unknown type is "expected one of these three" rather than a
 * missing-key error from the lookup.
 *
 * The published flags are the substance of all three, for the reason
 * `@/lib/cache/invalidation` gives: a blog cache entry only changes when a post
 * is visible to the public before or after the write, and an unpublish has to
 * drop exactly as much as a publish. Both flags are recorded by the mutation,
 * which observed them, rather than being re-read by the consumer, which would
 * be reading a row that has moved on since.
 */
export const outboxEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("post.created"),
    payload: z.object({ postId, published: z.boolean() }),
  }),
  z.object({
    type: z.literal("post.updated"),
    payload: z.object({
      postId,
      wasPublished: z.boolean(),
      isPublished: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal("post.deleted"),
    payload: z.object({ postId, wasPublished: z.boolean() }),
  }),
]);

/**
 * An event as a mutation emits it, and as the relay reads it back.
 *
 * One type for both directions on purpose. A separate "stored" type would let
 * the two drift, and the whole point of the schema above is that what comes out
 * of the column is the same shape as what went in.
 */
export type OutboxEvent = z.infer<typeof outboxEventSchema>;

/**
 * Reads a row's `type` and `payload` back into an event.
 *
 * Takes the two columns rather than a whole row so the relay's store interface
 * does not have to name a Prisma type, and so this can be called on a value
 * assembled by a test without constructing a row.
 */
export function parseOutboxEvent(
  type: string,
  payload: unknown,
): z.ZodSafeParseResult<OutboxEvent> {
  return outboxEventSchema.safeParse({ type, payload });
}

/**
 * The cache mutation an event implies.
 *
 * Total and exhaustive: the declared return type makes a new `OutboxEvent`
 * variant a type error here, which is the point at which someone has to decide
 * what it invalidates. That is the same property `tagsFor` has one layer down,
 * and it is deliberately duplicated rather than collapsed — this switch answers
 * "what does this fact mean for the cache", `tagsFor` answers "which tags does
 * that drop", and a new consumer adds a switch beside this one without touching
 * either.
 */
export function cacheMutationFor(event: OutboxEvent): CacheMutation {
  switch (event.type) {
    case "post.created":
      return {
        kind: "post.created",
        postId: event.payload.postId,
        published: event.payload.published,
      };
    case "post.updated":
      return {
        kind: "post.updated",
        postId: event.payload.postId,
        wasPublished: event.payload.wasPublished,
        isPublished: event.payload.isPublished,
      };
    case "post.deleted":
      return {
        kind: "post.deleted",
        postId: event.payload.postId,
        wasPublished: event.payload.wasPublished,
      };
  }
}
