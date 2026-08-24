/**
 * Asserts that each route's Suspense boundaries sit *below* the markup that
 * does not depend on the request, and that every boundary left pending in the
 * prerender has a real fallback behind it.
 *
 * This is the gate for the failure the route-shape gate cannot see. That one
 * asks "did this route prerender a shell?" — and a shell exists as soon as the
 * layout has one static byte in it. It says nothing about whether the *page*
 * put anything in that shell. `/dashboard`, `/posts` and `/admin` each opened
 * with `await getRequiredSession()`, so their entire bodies — headings,
 * card chrome, field labels, and on `/images` a 12 KB showcase that mentions
 * the visitor nowhere — sat behind a cookie read. Every one of them built as
 * `◐`, satisfied the route-shape gate, and shipped a shell whose only content
 * was the sidebar.
 *
 * So this gate asserts against the page's own markup: the heading that names
 * the route has to be in the HTML the build wrote, or the boundary is too high
 * again.
 *
 * The second half is about what fills the hole. `<Suspense fallback={null}>`
 * prerenders a shell that is technically correct and visibly worse than no
 * streaming at all: the page paints, then jumps when the hole resolves. Every
 * pending boundary here must have rendered something.
 *
 * Usage: tsx scripts/assert-streaming-boundaries.ts [path-to-.next]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export interface StreamingExpectation {
  /** Route path as it appears in the build output. */
  route: string;
  /**
   * Markup that must be in the prerendered document. Written as short markup
   * fragments (`">Posts</h1>"`) rather than bare words so a sidebar link to the
   * same route cannot satisfy the assertion the page is supposed to.
   */
  mustPrerender: readonly string[];
  /**
   * How many Suspense boundaries must still be pending when the prerender ends.
   *
   * A minimum, not an exact count: React may finish a boundary in place or
   * out of order depending on how the build's workers are scheduled, and the
   * point of the number is that the request-scoped reads are *outside* the
   * shell, not how many markers a particular run emitted.
   */
  minStreamedHoles: number;
  /** Why this route is expected to look like this — printed on failure. */
  because: string;
}

/**
 * As with the route-shape gate, the expectations are written down rather than
 * derived from the source. A gate that reads the same file it is checking only
 * ever agrees with it.
 *
 * Every dashboard route carries at least one hole for `<UserChip>` in
 * `(dashboard)/layout.tsx`; the counts below are that plus the page's own.
 */
export const EXPECTED_STREAMING: readonly StreamingExpectation[] = [
  {
    route: "/dashboard",
    mustPrerender: [">Dashboard</h1>", ">Session</h2>", ">User ID</dt>"],
    // <UserChip>, the greeting, the four session values, and the three
    // parallel-route slots. Floored well below that: the slots resolve
    // independently and their markers move between runs.
    minStreamedHoles: 3,
    because:
      "the heading, the card chrome and the field labels are the same for every visitor; only the values are not",
  },
  {
    route: "/posts",
    mustPrerender: [">Posts</h1>"],
    // <UserChip> and <PostsSection>.
    minStreamedHoles: 2,
    because:
      "the page heading must not wait on `getPostsByUser`; the count line and the list are the only parts that depend on who is asking",
  },
  {
    route: "/admin",
    mustPrerender: [
      ">Admin Panel</h1>",
      ">Admin Session</h2>",
      ">User ID</dt>",
    ],
    // <UserChip> and the session values.
    minStreamedHoles: 2,
    because:
      "an administrator sees the same panel chrome as every other administrator",
  },
  {
    route: "/images",
    mustPrerender: [
      ">Image Showcase</h1>",
      ">Fixed-size images</h2>",
      ">Using real LQIP</h2>",
    ],
    // <UserChip> only: nothing on this page is derived from the request.
    minStreamedHoles: 1,
    because:
      "every byte of this page is a literal; one `await getRequiredSession()` used to keep all 12 KB of it out of the shell",
  },
  {
    route: "/upload",
    mustPrerender: [">Image Upload</h1>", "Upload images directly to S3"],
    // <UserChip> only. The upload itself is authorised in the Server Action.
    minStreamedHoles: 1,
    because:
      "the page is a heading and a Client Component; the session is the upload action's business, not the page's",
  },
];

export interface Violation {
  route: string;
  problem: string;
  because: string;
}

/** Reads the prerendered HTML for a route, or `null` if the build wrote none. */
export type HtmlReader = (route: string) => string | null;

export function createHtmlReader(nextDir: string): HtmlReader {
  return (route) => {
    const relative = route === "/" ? "index" : route.replace(/^\//, "");
    try {
      return readFileSync(
        path.join(nextDir, "server", "app", `${relative}.html`),
        "utf8",
      );
    } catch {
      return null;
    }
  };
}

/**
 * The prerendered document for a route, normalised for matching.
 *
 * Currently the identity function, and the comment is the point. React finishes
 * some boundaries out of order even at build time — `/images` completes its
 * whole body into a trailing `<div hidden id="S:1">` with an inline
 * `$RC("B:1","S:1")` after it — and an earlier version of this gate excluded
 * those blocks on the theory that they are "not the shell". They are. The block
 * and the script that moves it into place are both in this file, served in the
 * same response, and parsed before the document finishes loading; nothing waits
 * on hydration or on a second request.
 *
 * What is *genuinely* dynamic never reaches this file at all. Under Cache
 * Components a request-scoped read aborts the prerender at its boundary, which
 * is why `/images` shipped 6.3 KB with no heading in it while a single
 * `await getRequiredSession()` sat at the top of the page. So "is this markup
 * in the prerendered document" is exactly the question worth asking, and the
 * position of the markup within it is not.
 */
export function prerenderedDocument(html: string): string {
  return html;
}

export interface PendingBoundary {
  /** Markup React painted in the hole while it waits. */
  fallback: string;
}

const OPEN_MARKERS = ["<!--$-->", "<!--$?-->", "<!--$!-->"];
const PENDING_MARKER = "<!--$?-->";
const CLOSE_MARKER = "<!--/$-->";

/**
 * Every Suspense boundary still pending at the end of the prerender, with the
 * fallback React left in its place.
 *
 * React marks a pending boundary `<!--$?-->`, follows it with the `<template>`
 * that anchors the replacement, then the fallback, then `<!--/$-->`. Boundaries
 * nest, so the close marker has to be matched by depth rather than by the next
 * occurrence — a nested resolved boundary inside a fallback would otherwise cut
 * the fallback short and make it look empty.
 */
export function pendingBoundaries(html: string): PendingBoundary[] {
  const found: PendingBoundary[] = [];

  for (let i = 0; i < html.length;) {
    const next = html.indexOf(PENDING_MARKER, i);
    if (next === -1) break;

    const contentStart = next + PENDING_MARKER.length;
    let depth = 1;
    let cursor = contentStart;

    while (depth > 0 && cursor < html.length) {
      const close = html.indexOf(CLOSE_MARKER, cursor);
      if (close === -1) break;

      const openAt = OPEN_MARKERS.map((marker) => {
        const at = html.indexOf(marker, cursor);
        return at === -1 || at > close ? -1 : at;
      }).filter((at) => at !== -1);

      if (openAt.length > 0) {
        depth += 1;
        cursor = Math.min(...openAt) + 1;
        continue;
      }

      depth -= 1;
      cursor = close + CLOSE_MARKER.length;
    }

    found.push({
      fallback: html
        .slice(
          contentStart,
          Math.max(contentStart, cursor - CLOSE_MARKER.length),
        )
        // The anchor React uses to find the hole again is not content.
        .replace(/<template[^>]*>\s*<\/template>/g, "")
        .trim(),
    });

    i = contentStart;
  }

  return found;
}

/**
 * Pure and reader-shaped rather than reading from disk, so the tests can
 * describe a regressed shell without running a build.
 */
export function checkStreamingBoundaries(
  readHtml: HtmlReader,
  expectations: readonly StreamingExpectation[] = EXPECTED_STREAMING,
): Violation[] {
  const violations: Violation[] = [];

  for (const {
    route,
    mustPrerender,
    minStreamedHoles,
    because,
  } of expectations) {
    const html = readHtml(route);

    if (html === null) {
      violations.push({
        route,
        problem:
          "no prerendered HTML was written for this route — it built as fully dynamic (ƒ), " +
          "so there is no shell for anything to be in.",
        because,
      });
      continue;
    }

    const document = prerenderedDocument(html);

    const missing = mustPrerender.filter(
      (needle) => !document.includes(needle),
    );
    if (missing.length > 0) {
      violations.push({
        route,
        problem:
          `the prerendered document is ${document.length} bytes but does not contain ${missing.map((m) => JSON.stringify(m)).join(", ")}. ` +
          "A Suspense boundary — or an `await` in the page component, which is the same thing one segment higher — " +
          "sits above markup that does not depend on the request.",
        because,
      });
    }

    const boundaries = pendingBoundaries(document);

    if (boundaries.length < minStreamedHoles) {
      violations.push({
        route,
        problem:
          `expected at least ${minStreamedHoles} streamed boundar${minStreamedHoles === 1 ? "y" : "ies"} ` +
          `left pending, found ${boundaries.length}. Request-scoped reads have moved into the prerender, ` +
          "which either means they are no longer request-scoped or that this route is about to become dynamic.",
        because,
      });
    }

    const empty = boundaries.filter((boundary) => boundary.fallback === "");
    if (empty.length > 0) {
      violations.push({
        route,
        problem:
          `${empty.length} of ${boundaries.length} streamed boundaries prerendered an empty fallback. ` +
          "A hole with nothing in it paints as collapsed space and then pushes the page around when it fills — " +
          "slower to read than not streaming at all. Give the boundary a fallback shaped like what it replaces.",
        because,
      });
    }
  }

  return violations;
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map(
      (v) =>
        `  ${v.route}\n    ${v.problem}\n    expected because: ${v.because}`,
    )
    .join("\n\n");
}

function main(argv: readonly string[]): number {
  const nextDir = argv[0] ?? ".next";
  const violations = checkStreamingBoundaries(createHtmlReader(nextDir));

  if (violations.length > 0) {
    console.error(
      `Streaming boundaries regressed — ${violations.length} problem(s):\n\n${formatViolations(violations)}\n`,
    );
    return 1;
  }

  console.log(
    `Streaming boundaries OK — ${EXPECTED_STREAMING.length} routes prerender their own markup.`,
  );
  return 0;
}

/* c8 ignore start -- CLI entry; the logic above is what the tests exercise. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
/* c8 ignore stop */
