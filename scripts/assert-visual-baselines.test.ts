import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JOURNEY,
  PROJECT_FOR_SURFACE,
  SURFACES,
} from "../e2e/support/journey.js";
import {
  compareBaselines,
  expectedBaselines,
  formatReport,
  main,
  presentBaselines,
  type Baseline,
} from "./assert-visual-baselines.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "visual-baselines-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(baselines: readonly Baseline[]): void {
  for (const { project, step } of baselines) {
    mkdirSync(path.join(root, project), { recursive: true });
    writeFileSync(path.join(root, project, `${step}.png`), "not really a png");
  }
}

describe("expectedBaselines", () => {
  it("derives one image per step per applicable surface", () => {
    const expected = expectedBaselines();
    const total = SURFACES.reduce(
      (sum, surface) =>
        sum + JOURNEY.filter((step) => step.surfaces.includes(surface)).length,
      0,
    );
    expect(expected).toHaveLength(total);
  });

  it("files each image under the project that walks that surface", () => {
    const projects = new Set(expectedBaselines().map((b) => b.project));
    expect([...projects].sort()).toEqual(
      [PROJECT_FOR_SURFACE.desktop, PROJECT_FOR_SURFACE.mobile].sort(),
    );
  });

  it("leaves a step out of the surfaces it does not apply to", () => {
    // The drawer is `lg:hidden`, so there is no desktop image of it. A step
    // that applied everywhere would make this vacuous, which is why it asserts
    // the asymmetry rather than a count.
    const narrowOnly = JOURNEY.filter(
      (step) => !step.surfaces.includes("desktop"),
    );
    expect(narrowOnly.length).toBeGreaterThan(0);
    const desktopSteps = expectedBaselines()
      .filter((b) => b.project === PROJECT_FOR_SURFACE.desktop)
      .map((b) => b.step);
    for (const step of narrowOnly) {
      expect(desktopSteps).not.toContain(step.id);
    }
  });
});

describe("presentBaselines", () => {
  it("is empty when the directory does not exist", () => {
    expect(presentBaselines(path.join(root, "nope"))).toEqual([]);
  });

  it("reads every png under every project directory", () => {
    write([
      { project: "journey-desktop", step: "landing" },
      { project: "journey-mobile", step: "landing" },
    ]);
    expect(presentBaselines(root)).toHaveLength(2);
  });

  it("ignores files that are not images", () => {
    write([{ project: "journey-desktop", step: "landing" }]);
    writeFileSync(path.join(root, "journey-desktop", "README.md"), "notes");
    expect(presentBaselines(root).map((b) => b.step)).toEqual(["landing"]);
  });
});

describe("compareBaselines", () => {
  const one: Baseline = { project: "p", step: "a" };
  const two: Baseline = { project: "p", step: "b" };

  it("reports nothing wrong when the sets agree", () => {
    const report = compareBaselines([one, two], [two, one]);
    expect(report).toMatchObject({ missing: [], orphaned: [], matched: 2 });
  });

  it("reports a step with no image", () => {
    expect(compareBaselines([one, two], [one]).missing).toEqual([two]);
  });

  it("reports an image with no step", () => {
    expect(compareBaselines([one], [one, two]).orphaned).toEqual([two]);
  });

  it("does not let an image for one project cover another's", () => {
    const desktop: Baseline = { project: "journey-desktop", step: "a" };
    const mobile: Baseline = { project: "journey-mobile", step: "a" };
    const report = compareBaselines([desktop, mobile], [desktop]);
    expect(report.missing).toEqual([mobile]);
  });
});

describe("formatReport", () => {
  it("names the missing images and points at the recording workflow", () => {
    const text = formatReport(
      compareBaselines([{ project: "journey-mobile", step: "nav-drawer" }], []),
    );
    expect(text).toContain("journey-mobile/nav-drawer.png");
    expect(text).toContain("update-snapshots");
  });

  it("explains that an orphan belongs to no step", () => {
    const text = formatReport(
      compareBaselines([], [{ project: "journey-desktop", step: "gone" }]),
    );
    expect(text).toContain("journey-desktop/gone.png");
    expect(text).toContain("Orphaned");
  });
});

describe("main", () => {
  it("passes when every expected image is present", () => {
    write(expectedBaselines());
    expect(main([root])).toBe(0);
  });

  it("fails when one is missing", () => {
    write(expectedBaselines().slice(1));
    expect(main([root])).toBe(1);
  });

  it("fails on an extra image nobody photographs", () => {
    write([...expectedBaselines(), { project: "journey-desktop", step: "x" }]);
    expect(main([root])).toBe(1);
  });

  it("fails rather than passing over an empty directory", () => {
    // The gate's own non-vacuity check: nothing expected and nothing present
    // compares equal, and a run that checked nothing should not be green.
    expect(main([root])).toBe(1);
  });
});
