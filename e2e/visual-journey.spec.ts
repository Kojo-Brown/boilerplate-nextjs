import { expect, test } from "@playwright/test";
import { JOURNEY, walk, type Surface } from "./support/journey";

/**
 * Pixel comparison over the same critical journey the accessibility suite
 * walks.
 *
 * The two suites answer different questions about the same eight states, and
 * neither covers the other. axe reads the accessibility tree: it will tell you
 * that a control has no name and that text fails contrast, and it is entirely
 * untroubled by a stylesheet that failed to load, a grid that collapsed to one
 * column, an overlay rendered behind the content it is meant to cover, or a
 * heading that is now the same size as the body text. Those are the regressions
 * a screenshot catches and nothing else in this repository does — the
 * bundle-budget gate measures bytes, `assert-css-output.ts` measures that the
 * stylesheet exists, and the unit suite renders into a DOM with no layout at
 * all.
 *
 * ## The baselines are recorded in CI, not locally
 *
 * Text rasterisation depends on the Chromium build and on the fonts installed
 * next to it, so a baseline is only meaningful against the environment that
 * produced it. The authoring sandbox for this repository cannot even reach
 * `cdn.playwright.dev` to install the pinned browser — it has a Chromium nine
 * builds newer — so a baseline recorded there would differ from CI on every
 * step, by an amount nobody could act on, and the usual response to that is a
 * `maxDiffPixelRatio` large enough to make the gate meaningless.
 *
 * So the recording happens where the verification happens.
 * `.github/workflows/update-snapshots.yml` runs this suite with
 * `--update-snapshots` on the CI runner and commits what it produces. See
 * docs/visual-regression.md.
 *
 * ## Why the viewport and not the full page
 *
 * `fullPage: true` makes the image's height a function of the content, so a
 * post added to the seed resizes four baselines and the diff is unreadable. It
 * is also wrong for the two states this suite exists to cover: a modal overlay
 * is `position: fixed`, so in a full-page screenshot of a scrollable page it is
 * painted over the top slice and the rest of the image is the page behind it.
 * The viewport is what a visitor sees and what the overlay is positioned
 * against.
 */
const surfaceOf = (projectName: string): Surface =>
  projectName === "journey-mobile" ? "mobile" : "desktop";

test.describe("Critical journey — visual regression", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  test("matches the committed baseline at every step", async ({
    page,
  }, testInfo) => {
    const surface = surfaceOf(testInfo.project.name);
    const photographed: string[] = [];

    await walk(page, surface, async (step) => {
      await test.step(`${step.id} — ${step.title}`, async () => {
        photographed.push(step.id);
        await expect(page).toHaveScreenshot(`${step.id}.png`, {
          // Every CSS transition and animation is finished and rewound before
          // the shot. Without it the dialog's own fade is a different frame on
          // every run, which is the difference between a gate and a coin toss.
          animations: "disabled",
          // The text caret blinks. Three of these states have a focused input
          // in them — the registration form, the sign-in form and the
          // create-post dialog, whose title field carries `autoFocus` — so
          // without this the gate fails roughly half the time on a single
          // one-pixel column.
          caret: "hide",
          ...(step.mask && { mask: [...step.mask(page)] }),
        });
      });
    });

    // The suite's own non-vacuity check. `toHaveScreenshot` cannot fail for a
    // step that was never reached, and `walk` would silently photograph nothing
    // at all if the registry were empty or every step were filtered out by
    // surface — a green run over zero images. The expected count comes from the
    // registry rather than from a literal, so adding a step does not need this
    // line edited; it needs a baseline recorded, which is what
    // `scripts/assert-visual-baselines.ts` insists on.
    const expected = JOURNEY.filter((step) =>
      step.surfaces.includes(surface),
    ).map((step) => step.id);
    expect(photographed).toEqual(expected);
  });
});
