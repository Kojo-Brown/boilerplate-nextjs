import { describe, it, expect } from "vitest";
import { BLOG_POSTS_TAG, blogPostTag } from "@/lib/cache/tags";
import { tagsFor } from "@/lib/cache/invalidation";
import {
  REVALIDATE_EVENTS,
  mutationFor,
  revalidateEventSchema,
} from "./revalidate-events";
import type { RevalidateEvent } from "./revalidate-events";

describe("revalidateEventSchema", () => {
  it("accepts every documented event", () => {
    const payloads: unknown[] = [
      { event: "post.published", postId: "post-1" },
      { event: "post.updated", postId: "post-1" },
      { event: "post.unpublished", postId: "post-1" },
      { event: "post.deleted", postId: "post-1" },
      { event: "blog.refresh" },
      { event: "ping" },
    ];

    for (const payload of payloads) {
      expect(revalidateEventSchema.safeParse(payload).success).toBe(true);
    }
  });

  it("rejects a near-miss event name rather than accepting it as a no-op", () => {
    // The failure this schema exists to make loud. A CMS configured to send
    // `post.publish` against a permissive schema gets 200s forever while the
    // blog stays stale, and nothing anywhere reports it.
    expect(
      revalidateEventSchema.safeParse({ event: "post.publish", postId: "p" })
        .success,
    ).toBe(false);
  });

  it("requires a post id for the post events", () => {
    expect(
      revalidateEventSchema.safeParse({ event: "post.published" }).success,
    ).toBe(false);
    expect(
      revalidateEventSchema.safeParse({ event: "post.published", postId: "" })
        .success,
    ).toBe(false);
  });

  it("does not require one for the blog-wide events", () => {
    expect(revalidateEventSchema.safeParse({ event: "ping" }).success).toBe(
      true,
    );
  });

  it("rejects a payload that is not an object", () => {
    expect(revalidateEventSchema.safeParse("post.published").success).toBe(
      false,
    );
    expect(revalidateEventSchema.safeParse(null).success).toBe(false);
  });
});

describe("REVALIDATE_EVENTS", () => {
  it("lists exactly the events the schema accepts", () => {
    // The list is what the 422 message prints, so a new event added to the
    // schema and not to the list would be accepted and undocumented.
    for (const event of REVALIDATE_EVENTS) {
      const payload = event.startsWith("post.")
        ? { event, postId: "p" }
        : { event };
      expect(revalidateEventSchema.safeParse(payload).success).toBe(true);
    }

    expect(revalidateEventSchema.options.length).toBe(REVALIDATE_EVENTS.length);
  });
});

/**
 * The mapping is where the external vocabulary meets this application's policy,
 * so every case is asserted against `tagsFor` rather than against the mutation
 * shape. What matters is which tags an event ends up dropping; the intermediate
 * `CacheMutation` is an implementation detail of getting there.
 */
describe("mutationFor", () => {
  function tagsForEvent(event: RevalidateEvent): readonly string[] {
    const mutation = mutationFor(event);
    return mutation === null ? [] : tagsFor(mutation);
  }

  it("drops the post and the list when a post is published", () => {
    expect(tagsForEvent({ event: "post.published", postId: "post-1" })).toEqual(
      [blogPostTag("post-1"), BLOG_POSTS_TAG],
    );
  });

  it("drops as much for an unpublish as for a publish", () => {
    // The case that a "is it live now?" reading of the event gets wrong: after
    // an unpublish there is no public post, and that is exactly why the page
    // still serving one has to go.
    expect(
      tagsForEvent({ event: "post.unpublished", postId: "post-1" }),
    ).toEqual(tagsForEvent({ event: "post.published", postId: "post-1" }));
  });

  it("drops the post and the list when a post is deleted", () => {
    // Reported as `wasPublished: true` because a CMS deleting a draft is
    // indistinguishable from one deleting a live post, and only the second
    // mistake leaves a dead page cached.
    expect(tagsForEvent({ event: "post.deleted", postId: "post-1" })).toEqual([
      blogPostTag("post-1"),
      BLOG_POSTS_TAG,
    ]);
  });

  it("drops the list for a blog-wide refresh", () => {
    expect(tagsForEvent({ event: "blog.refresh" })).toEqual([BLOG_POSTS_TAG]);
  });

  it("drops nothing for a ping", () => {
    // A CMS's "send test event" button must not purge production's cache.
    expect(mutationFor({ event: "ping" })).toBeNull();
    expect(tagsForEvent({ event: "ping" })).toEqual([]);
  });

  it("scopes the per-post tag to the id it was given", () => {
    expect(tagsForEvent({ event: "post.updated", postId: "post-7" })).toContain(
      blogPostTag("post-7"),
    );
  });

  it("never reports a mutation that drops nothing for a post event", () => {
    // A post event mapping to a `wasPublished: false, isPublished: false` pair
    // would answer 200 with an empty tag list — the "verified, understood,
    // did nothing" outcome this whole layer is shaped against.
    const postEvents: RevalidateEvent[] = [
      { event: "post.published", postId: "p" },
      { event: "post.updated", postId: "p" },
      { event: "post.unpublished", postId: "p" },
      { event: "post.deleted", postId: "p" },
    ];

    // Guards the list above against a post event being added to the schema and
    // not to this test, which would leave the new one unchecked.
    expect(postEvents.map((event) => event.event)).toEqual(
      REVALIDATE_EVENTS.filter((event) => event.startsWith("post.")),
    );

    for (const event of postEvents) {
      expect(
        tagsForEvent(event).length,
        `${event.event} dropped no tags`,
      ).toBeGreaterThan(0);
    }
  });
});
