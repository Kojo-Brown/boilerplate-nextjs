import { describe, it, expect } from "vitest";
import { BLOG_POSTS_TAG, blogPostTag } from "./tags";

/**
 * Tag strings are a contract between a cached read and a mutation that never
 * call each other, and nothing in the type system connects them. These are the
 * cheap assertions that keep the namespace from colliding with itself — the
 * failure a collision produces is one tag purging entries it was never meant
 * to, which no other test would notice.
 */
describe("cache tags", () => {
  it("namespaces the list tag", () => {
    expect(BLOG_POSTS_TAG).toBe("blog:posts");
  });

  it("derives a distinct tag per post id", () => {
    expect(blogPostTag("post-1")).toBe("blog:post:post-1");
    expect(blogPostTag("post-1")).not.toBe(blogPostTag("post-2"));
    expect(blogPostTag("post-1")).toContain("post-1");
  });

  it("is a pure function of the id", () => {
    expect(blogPostTag("post-1")).toBe(blogPostTag("post-1"));
    expect(blogPostTag("a")).not.toBe(blogPostTag("b"));
  });

  it("keeps per-post tags out of the list tag's namespace", () => {
    // `blog:post:…` and `blog:posts` are one character apart. An id could not
    // collide with the list tag today, but the prefixes are close enough that
    // a future rename should have to break this test to do it.
    expect(blogPostTag("s")).not.toBe(BLOG_POSTS_TAG);
    expect(blogPostTag("s").startsWith(`${BLOG_POSTS_TAG}:`)).toBe(false);
  });
});
