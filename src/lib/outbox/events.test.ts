import { describe, it, expect } from "vitest";
import {
  OUTBOX_EVENT_TYPES,
  cacheMutationFor,
  outboxEventSchema,
  parseOutboxEvent,
} from "./events";
import type { OutboxEvent } from "./events";
import { tagsFor } from "@/lib/cache/invalidation";
import { BLOG_POSTS_TAG, blogPostTag } from "@/lib/cache/tags";

describe("the event taxonomy", () => {
  it("lists exactly the types the schema accepts", () => {
    // Two spellings of one set: the `as const` list and the union's own
    // discriminators. This is what fails when a type is added to one and not
    // the other — the list is what the relay quotes back in an error message,
    // so a stale entry would name an event nothing can produce.
    const discriminators = outboxEventSchema.options.map(
      (option) => option.shape.type.value,
    );

    expect([...discriminators].sort()).toEqual([...OUTBOX_EVENT_TYPES].sort());
  });

  it("refuses a type outside the union", () => {
    expect(parseOutboxEvent("post.archived", { postId: "p1" }).success).toBe(
      false,
    );
  });
});

describe("parsing a row back into an event", () => {
  it("accepts a payload written by the current producers", () => {
    const parsed = parseOutboxEvent("post.updated", {
      postId: "post-1",
      wasPublished: false,
      isPublished: true,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({
      type: "post.updated",
      payload: { postId: "post-1", wasPublished: false, isPublished: true },
    });
  });

  it("refuses a payload whose booleans arrived as strings", () => {
    // The shape a hand-written INSERT or a producer from another language
    // produces. It would type check downstream — `"false"` is truthy, so an
    // unpublish would invalidate as though it were a publish, which is the
    // quieter half of the bug.
    const parsed = parseOutboxEvent("post.deleted", {
      postId: "post-1",
      wasPublished: "false",
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a payload missing a field the consumer reads", () => {
    const parsed = parseOutboxEvent("post.updated", {
      postId: "post-1",
      isPublished: true,
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a payload for the wrong event type", () => {
    // `post.created` carries `published`, not `wasPublished`. Discriminating on
    // `type` is what makes this a failure rather than a silently empty payload.
    const parsed = parseOutboxEvent("post.created", {
      postId: "post-1",
      wasPublished: true,
    });

    expect(parsed.success).toBe(false);
  });

  it("strips fields the schema does not declare", () => {
    const parsed = outboxEventSchema.parse({
      type: "post.created",
      payload: { postId: "post-1", published: true, extra: "ignored" },
    });

    expect(parsed.payload).toEqual({ postId: "post-1", published: true });
  });
});

describe("cacheMutationFor", () => {
  it("carries a publish through to both blog tags", () => {
    const event: OutboxEvent = {
      type: "post.updated",
      payload: { postId: "post-1", wasPublished: false, isPublished: true },
    };

    expect(tagsFor(cacheMutationFor(event))).toEqual([
      blogPostTag("post-1"),
      BLOG_POSTS_TAG,
    ]);
  });

  it("carries an unpublish through to the same tags", () => {
    // The edge the whole policy turns on: nothing is public afterwards, and the
    // cached page must still start returning a 404. An event mapped by "is it
    // published now?" would drop nothing here.
    const event: OutboxEvent = {
      type: "post.updated",
      payload: { postId: "post-1", wasPublished: true, isPublished: false },
    };

    expect(tagsFor(cacheMutationFor(event))).toEqual([
      blogPostTag("post-1"),
      BLOG_POSTS_TAG,
    ]);
  });

  it("drops nothing for a draft's lifecycle", () => {
    expect(
      tagsFor(
        cacheMutationFor({
          type: "post.created",
          payload: { postId: "post-1", published: false },
        }),
      ),
    ).toEqual([]);

    expect(
      tagsFor(
        cacheMutationFor({
          type: "post.deleted",
          payload: { postId: "post-1", wasPublished: false },
        }),
      ),
    ).toEqual([]);
  });

  it("maps every event type to a mutation the cache policy understands", () => {
    // A new event type reaches `tagsFor` through this mapping, and `tagsFor`
    // returning `undefined` for one would be a cache that silently stops
    // invalidating. Exhaustiveness is a compile-time property of
    // `cacheMutationFor`; this is the runtime half.
    const events: OutboxEvent[] = [
      { type: "post.created", payload: { postId: "p", published: true } },
      {
        type: "post.updated",
        payload: { postId: "p", wasPublished: true, isPublished: true },
      },
      { type: "post.deleted", payload: { postId: "p", wasPublished: true } },
    ];

    expect(events.map((event) => event.type).sort()).toEqual(
      [...OUTBOX_EVENT_TYPES].sort(),
    );

    for (const event of events) {
      expect(Array.isArray(tagsFor(cacheMutationFor(event)))).toBe(true);
    }
  });
});
