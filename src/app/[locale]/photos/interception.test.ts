import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Intercepting routes are a filesystem contract, and every way of breaking
 * them is silent.
 *
 * Rename `(.)` to `(..)`, move `@modal` one segment deeper, drop
 * `default.tsx`, or stop rendering `{modal}` in the root layout, and the
 * application still compiles, still type checks, still passes every component
 * test, and still serves `/photos/<id>` correctly. The only symptom is that
 * clicking a photo does a full-page navigation instead of opening the modal —
 * a behaviour no unit test observes and no build gate reports.
 *
 * So the contract is asserted directly. `scripts/assert-route-shape.ts` does
 * the same thing one level up, for the same reason: the interesting failures
 * in this application are the ones that leave everything green.
 */
const APP = path.join(process.cwd(), "src", "app");

/**
 * Written out longhand rather than composed from variables. A constant shared
 * with the code under test would follow it wherever it drifted to, which is
 * exactly what this file is here to prevent.
 */
const INTERCEPTOR = "src/app/@modal/(.)photos/[id]/page.tsx";
const SLOT_DEFAULT = "src/app/@modal/default.tsx";
const INTERCEPTED_ROUTE = "src/app/photos/[id]/page.tsx";

function repoFile(relative: string): string {
  return path.join(process.cwd(), relative);
}

describe("intercepting route wiring", () => {
  it("puts the interceptor at the one path that resolves", () => {
    expect(
      existsSync(repoFile(INTERCEPTOR)),
      `${INTERCEPTOR} is missing. \`(.)\` matches the same routing level as the ` +
        "slot, and `@modal` sits at the application root — so the marker for " +
        "`app/photos/[id]` is `(.)`, regardless of how deep this file is on disk. " +
        "With the wrong marker the route resolves to nothing and every photo click " +
        "becomes a full page load, with no error anywhere.",
    ).toBe(true);
  });

  it("gives the slot a default, without which every hard navigation 404s", () => {
    expect(
      existsSync(repoFile(SLOT_DEFAULT)),
      `${SLOT_DEFAULT} is missing. A parallel slot with no default has nothing ` +
        "to render on a URL it does not match and no previous router state to " +
        "fall back on, so a reload of any page in the app fails — while " +
        "client-side navigation keeps working, which is why this survives dev.",
    ).toBe(true);
  });

  it("keeps the route the interceptor shadows", () => {
    expect(
      existsSync(repoFile(INTERCEPTED_ROUTE)),
      `${INTERCEPTED_ROUTE} is missing. The interceptor only covers soft ` +
        "navigations; a shared link, a reload and a new tab all need the real route.",
    ).toBe(true);
  });

  it("renders the slot in the root layout", () => {
    // Rendering `children` but not `modal` is the failure that looks most like
    // working code: the slot resolves, the page navigates, the URL updates,
    // and the modal is simply never mounted.
    const layout = readFileSync(path.join(APP, "layout.tsx"), "utf8");
    expect(layout).toContain("{modal}");
    expect(layout).toMatch(/modal:\s*React\.ReactNode/);
  });

  it("keeps @modal a sibling of photos, not a descendant of it", () => {
    // `app/photos/@modal/(.)[id]` is the plausible-looking arrangement that
    // does not work: the slot would then live one segment down, and `(.)`
    // would resolve against `/photos/*`, not `/photos`.
    expect(existsSync(path.join(APP, "@modal"))).toBe(true);
    expect(existsSync(path.join(APP, "photos", "@modal"))).toBe(false);
  });
});
