import { describe, expect, it } from "vitest";
import {
  EXPECTED_STREAMING,
  checkStreamingBoundaries,
  formatViolations,
  pendingBoundaries,
  type HtmlReader,
  type StreamingExpectation,
  type Violation,
} from "./assert-streaming-boundaries";

/**
 * React's streaming markers, spelled out once so the fixtures below read as
 * markup rather than as punctuation.
 *
 * `PENDING` opens a boundary whose content has not arrived; the markup between
 * it and `CLOSE` is the fallback. `RESOLVED` opens one that has.
 */
const PENDING = '<!--$?--><template id="B:0"></template>';
const RESOLVED = "<!--$-->";
const CLOSE = "<!--/$-->";

function hole(fallback: string): string {
  return `${PENDING}${fallback}${CLOSE}`;
}

/**
 * A page shaped like `/posts` after this change: the heading is page markup and
 * prerenders, the list is a hole with a skeleton in it.
 */
function healthyPostsHtml(): string {
  return (
    "<html><body><nav><a>Posts</a></nav><main>" +
    '<h1 class="text-2xl">Posts</h1>' +
    hole('<div class="animate-pulse h-5 w-44"></div>') +
    "</main></body></html>"
  );
}

const POSTS_EXPECTATION: StreamingExpectation = {
  route: "/posts",
  mustPrerender: [">Posts</h1>"],
  minStreamedHoles: 1,
  because: "the heading does not depend on who is asking",
};

function readerFor(html: string | null): HtmlReader {
  return () => html;
}

/**
 * The single violation a fixture is expected to produce.
 *
 * Asserting the count here rather than indexing blind is what makes a case that
 * accidentally trips two rules fail loudly instead of silently checking the
 * wrong one.
 */
function onlyViolation(violations: readonly Violation[]): Violation {
  expect(violations).toHaveLength(1);
  return violations[0]!;
}

describe("pendingBoundaries", () => {
  it("returns the fallback markup React left in each hole", () => {
    const found = pendingBoundaries(hole("<span>loading</span>"));

    expect(found).toHaveLength(1);
    // The `<template>` anchor is React's bookkeeping, not something a reader
    // ever sees, so it must not count towards the fallback being non-empty.
    expect(found[0]!.fallback).toBe("<span>loading</span>");
  });

  it("ignores boundaries that already resolved", () => {
    const html = `${RESOLVED}<p>arrived</p>${CLOSE}${hole("<i>waiting</i>")}`;

    expect(pendingBoundaries(html).map((b) => b.fallback)).toEqual([
      "<i>waiting</i>",
    ]);
  });

  it("matches the closing marker by depth, not by the next occurrence", () => {
    // A resolved boundary nested inside a fallback — Next does this whenever a
    // slot's own `loading.tsx` sits inside a parent segment's. Counting the
    // first `<!--/$-->` as the end would cut the fallback in half and report an
    // empty one for the outer boundary.
    const nested = hole(
      `<div class="animate-pulse">a</div>${RESOLVED}<p>inner</p>${CLOSE}<div class="animate-pulse">b</div>`,
    );

    const outer = pendingBoundaries(nested)[0]!;

    expect(outer.fallback).toContain('<div class="animate-pulse">b</div>');
  });

  it("reports a boundary whose fallback rendered nothing", () => {
    expect(pendingBoundaries(hole("")).map((b) => b.fallback)).toEqual([""]);
  });
});

describe("checkStreamingBoundaries", () => {
  it("passes a page whose own markup is in the prerendered document", () => {
    const violations = checkStreamingBoundaries(readerFor(healthyPostsHtml()), [
      POSTS_EXPECTATION,
    ]);

    expect(violations).toEqual([]);
  });

  it("fails when the page heading is behind the boundary", () => {
    // The regression this gate exists for: `export default async function
    // PostsPage()` with `await getRequiredSession()` on the first line. The
    // route still prerenders — the chrome and the segment skeleton are there —
    // and the route-shape gate is still satisfied, because a shell exists.
    // Nothing the page itself renders is in it.
    const hoisted =
      "<html><body><nav><a>Posts</a></nav><main>" +
      hole('<div class="animate-pulse h-8 w-24"></div>') +
      "</main></body></html>";

    const violation = onlyViolation(
      checkStreamingBoundaries(readerFor(hoisted), [POSTS_EXPECTATION]),
    );

    expect(violation.route).toBe("/posts");
    expect(violation.problem).toContain('">Posts</h1>"');
    // The nav link says "Posts" too. The needle carries the closing tag for
    // exactly this reason, and the failure has to survive its presence.
    expect(hoisted).toContain("<a>Posts</a>");
  });

  it("fails a boundary that prerendered an empty fallback", () => {
    const noFallback =
      "<html><body><main><h1>Posts</h1>" + hole("") + "</main></body></html>";

    const violation = onlyViolation(
      checkStreamingBoundaries(readerFor(noFallback), [POSTS_EXPECTATION]),
    );

    expect(violation.problem).toContain("empty fallback");
  });

  it("fails when there is no prerendered HTML at all", () => {
    const violation = onlyViolation(
      checkStreamingBoundaries(readerFor(null), [POSTS_EXPECTATION]),
    );

    expect(violation.problem).toContain("fully dynamic");
  });

  it("fails when a request-scoped read has moved into the prerender", () => {
    // No holes left: whatever used to stream is now baked into the static
    // document, which for a page that renders a session means it is baked in
    // for everyone.
    const noHoles = "<html><body><main><h1>Posts</h1></main></body></html>";

    const violation = onlyViolation(
      checkStreamingBoundaries(readerFor(noHoles), [POSTS_EXPECTATION]),
    );

    expect(violation.problem).toContain(
      "expected at least 1 streamed boundary",
    );
  });

  it("names the route, the problem and the reason on failure", () => {
    const violations = checkStreamingBoundaries(readerFor(null), [
      POSTS_EXPECTATION,
    ]);

    const report = formatViolations(violations);

    expect(report).toContain("/posts");
    expect(report).toContain("expected because:");
    expect(report).toContain(POSTS_EXPECTATION.because);
  });
});

describe("EXPECTED_STREAMING", () => {
  it("covers every route whose page renders behind a boundary", () => {
    expect(EXPECTED_STREAMING.map((e) => e.route)).toEqual([
      "/dashboard",
      "/posts",
      "/admin",
      "/images",
      "/upload",
    ]);
  });

  it("expects at least one hole everywhere, for <UserChip>", () => {
    // Every one of these routes is under `(dashboard)/layout.tsx`, whose header
    // streams the signed-in identity. A route here with `minStreamedHoles: 0`
    // would mean that boundary had gone missing.
    for (const expectation of EXPECTED_STREAMING) {
      expect(expectation.minStreamedHoles).toBeGreaterThanOrEqual(1);
    }
  });

  it("uses needles the navigation chrome cannot satisfy", () => {
    // Every one of these documents contains the sidebar, and the sidebar names
    // most of these routes. `"Posts"` as a needle would be satisfied by the
    // link to `/posts` whatever the page itself rendered — a needle that
    // cannot fail. The expectations carry a closing tag, or prose the nav does
    // not contain, for exactly this reason.
    const NAV_LABELS = [
      "Dashboard",
      "Posts",
      "Upload",
      "Images",
      "Image Showcase",
      "Admin",
    ];

    for (const expectation of EXPECTED_STREAMING) {
      for (const needle of expectation.mustPrerender) {
        expect(NAV_LABELS).not.toContain(needle);
      }
    }
  });
});
