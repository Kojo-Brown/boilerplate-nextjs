import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  refresh: vi.fn(),
}));

import { updateTag } from "next/cache";
import { BLOG_POSTS_TAG } from "@/lib/cache/tags";
import { revalidateBlogAction } from "./blog";

const mockUpdateTag = vi.mocked(updateTag);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("revalidateBlogAction", () => {
  it("invalidates the published-post list for a known target", async () => {
    const result = await revalidateBlogAction("/blog");

    expect(result).toEqual({
      success: true,
      data: { path: "/blog", tags: [BLOG_POSTS_TAG] },
    });
    expect(mockUpdateTag).toHaveBeenCalledExactlyOnceWith(BLOG_POSTS_TAG);
  });

  it("rejects a target that is not on the allowlist", async () => {
    const result = await revalidateBlogAction("/admin");

    // The allowlist is the schema now (`z.string().pipe(z.enum(…))`), so the
    // rejection arrives as a validation failure rather than a hand-built
    // message. What matters is unchanged: the argument named a tag and got
    // nowhere.
    expect(result).toEqual({
      success: false,
      error: "Not a revalidation target.",
      fieldErrors: { _: ["Not a revalidation target."] },
    });
    expect(mockUpdateTag).not.toHaveBeenCalled();
  });

  it("invalidates nothing when the target is rejected", async () => {
    // The action is reachable by anyone who can reach the page, so an
    // arbitrary argument must not be able to name a cache tag.
    for (const target of ["", "/", "blog", "/blog/", "../blog", "blog:posts"]) {
      await revalidateBlogAction(target);
    }

    expect(mockUpdateTag).not.toHaveBeenCalled();
  });

  it("does not treat inherited Object properties as targets", async () => {
    // `Object.hasOwn` rather than `in` or a truthiness check: "constructor"
    // and "toString" are present on any plain object's prototype chain.
    const result = await revalidateBlogAction("constructor");

    expect(result.success).toBe(false);
    expect(mockUpdateTag).not.toHaveBeenCalled();
  });
});

/**
 * `revalidatePost` used to be exported from this module and is covered here no
 * longer. It has not been dropped — the behaviour it had (both tags, scoped per
 * id) is asserted against `tagsFor`/`invalidate` in
 * `src/lib/cache/invalidation.test.ts`, where it now lives. What it stopped
 * being is a Server Action: as an export of a `"use server"` module it was an
 * endpoint anyone could call with an arbitrary post id.
 */
describe("the module's action surface", () => {
  it("exports exactly one action", async () => {
    // Not a style assertion. Every export here is a network-reachable endpoint,
    // so a helper added to this file for convenience is a public API whether or
    // not that was intended, and this is the only place that fact is visible.
    const actions = await import("./blog");

    expect(Object.keys(actions).filter((key) => key !== "default")).toEqual([
      "revalidateBlogAction",
    ]);
  });
});
