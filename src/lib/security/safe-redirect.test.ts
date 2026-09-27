import { describe, expect, it } from "vitest";

import {
  DEFAULT_REDIRECT_PATH,
  isSiteRelativePath,
  safeRedirectPath,
} from "@/lib/security/safe-redirect";

/**
 * The base a redirect in this application is resolved against. Any origin does;
 * what matters is that the assertions below go through the same parser a browser
 * and `Response.redirect` use, rather than through a second opinion about what
 * these strings mean.
 */
const BASE = new URL("https://app.example/login");

/** Where `new URL(candidate, BASE)` actually lands, or the throw it produces. */
function resolve(candidate: string): string {
  try {
    return new URL(candidate, BASE).href;
  } catch {
    return "THROWS";
  }
}

describe("isSiteRelativePath", () => {
  it("accepts a path, a query and a fragment", () => {
    for (const path of [
      "/",
      "/dashboard",
      "/posts/abc123",
      "/blog?draft=1",
      "/blog?draft=1#section",
      "/a/\\b", // a backslash that is not in the authority position
    ]) {
      expect(isSiteRelativePath(path), path).toBe(true);
      expect(resolve(path).startsWith("https://app.example/"), path).toBe(true);
    }
  });

  it("rejects every shape the URL parser reads as another origin", () => {
    // Each of these starts with "/" — which is the whole reason this function
    // exists — and each resolves off-origin or throws. The second assertion is
    // what keeps that claim honest: it is the parser saying so, not a comment.
    for (const path of [
      "//evil.example",
      "//evil.example/dashboard",
      "/\\evil.example",
      "/\\\\evil.example",
      "/\t/evil.example",
      "//",
    ]) {
      expect(isSiteRelativePath(path), path).toBe(false);
      expect(resolve(path).startsWith("https://app.example/"), path).toBe(
        false,
      );
    }
  });

  it("rejects absolute URLs and scheme-bearing strings", () => {
    for (const path of [
      "https://evil.example",
      "http://evil.example/dashboard",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "dashboard",
      "",
    ]) {
      expect(isSiteRelativePath(path), path).toBe(false);
    }
  });

  it("rejects control characters, which split a Location header", () => {
    expect(isSiteRelativePath("/blog\r\nSet-Cookie: a=b")).toBe(false);
    expect(isSiteRelativePath("/blog\n")).toBe(false);
    expect(isSiteRelativePath("/blog\u0000")).toBe(false);
    expect(isSiteRelativePath("/blog\u007f")).toBe(false);
  });

  it("accepts a percent-encoded slash pair, which stays on this origin", () => {
    // `%2F%2F` is not an authority: it is two encoded characters in the path,
    // and the parser leaves it there. Rejecting it would be a false positive,
    // so this pins that the check is about parsing rather than about substrings.
    expect(isSiteRelativePath("/%2F%2Fevil.example")).toBe(true);
    expect(resolve("/%2F%2Fevil.example")).toBe(
      "https://app.example/%2F%2Fevil.example",
    );
  });
});

describe("safeRedirectPath", () => {
  it("returns a site-relative candidate unchanged", () => {
    expect(safeRedirectPath("/dashboard?tab=posts", "/fallback")).toBe(
      "/dashboard?tab=posts",
    );
  });

  it("substitutes the fallback for anything off-origin", () => {
    for (const candidate of ["//evil.example", "https://evil.example", "//"]) {
      expect(safeRedirectPath(candidate, "/dashboard"), candidate).toBe(
        "/dashboard",
      );
    }
  });

  it("substitutes the fallback for an absent candidate", () => {
    expect(safeRedirectPath(null, "/dashboard")).toBe("/dashboard");
    expect(safeRedirectPath(undefined, "/dashboard")).toBe("/dashboard");
  });

  it("defaults the fallback to the site root", () => {
    expect(safeRedirectPath("//evil.example")).toBe(DEFAULT_REDIRECT_PATH);
  });

  it("throws on a fallback that is not itself site-relative", () => {
    // A fallback is a literal in the source, so the only way this fires is a
    // programming error — and failing loudly beats quietly redirecting to the
    // attacker-controlled destination the fallback was meant to replace.
    expect(() => safeRedirectPath("/ok", "//evil.example")).toThrow(
      /not a site-relative path/,
    );
  });
});
