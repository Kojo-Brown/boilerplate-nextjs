import { expect, test, type Locator, type Page } from "@playwright/test";
import { audit, formatFindings, installAxe, type Finding } from "./support/axe";
import { walk, type Surface } from "./support/journey";

/**
 * WCAG 2.2 AA over the critical journey, in a browser, after hydration and
 * after a click.
 *
 * `scripts/assert-accessibility.ts` is the other half of this and the two do
 * not overlap. It audits 60 prerendered documents with nothing hydrated and
 * nothing clicked, which is the right way to make a claim about the bytes a
 * visitor parses first — and it means the entire interactive surface is outside
 * it. `docs/accessibility.md` lists what that leaves: a dialog, a drawer, a
 * validation message that only exists after a failed submit, content that
 * arrives from behind a Suspense boundary, and `target-size` at a width where a
 * touch target is actually cramped. Eight states here, at two widths, are that
 * list.
 *
 * Findings are collected and reported together rather than asserted per step.
 * A suite that stops at the first violation turns a page with nine of them into
 * nine CI runs, which is what reading the locale move's 92 findings would have
 * cost if the gate had been written that way.
 */
const surfaceOf = (projectName: string): Surface =>
  projectName === "journey-mobile" ? "mobile" : "desktop";

/** Where the focus is, as a selector-ish string, for a readable failure. */
const activeDescription = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return "null";
    const name =
      el.getAttribute("aria-label") ??
      el.textContent?.trim().slice(0, 40) ??
      "";
    return `${el.tagName.toLowerCase()}${name === "" ? "" : ` “${name}”`}`;
  });

/**
 * The three things an `aria-modal` overlay owes the keyboard, asserted against
 * the overlay that is currently open.
 *
 * None of this is reachable from axe, which automates no focus-trap rule, and
 * none of it is reachable from the unit suites either: jsdom implements no
 * sequential focus navigation, so `Tab` moves nothing there and a trap that
 * does not exist is indistinguishable from one that does. That is the whole
 * reason these assertions are in the browser suite.
 *
 * It leaves the overlay open, because the journey's next step is written
 * against it being open.
 */
async function assertModalKeyboardBehaviour(
  page: Page,
  overlay: Locator,
  reopen: Locator,
): Promise<void> {
  // 1. The focus went in. `aria-modal="true"` tells a screen reader to ignore
  //    everything outside this element, so a focus left on the trigger is a
  //    focus on something the user has just been told is not there.
  // Polled rather than asserted once: the focus move happens in an effect that
  // runs after the portalled panel first renders, so there is a frame in which
  // the overlay is visible and the focus has not moved yet.
  await expect
    .poll(() => overlay.evaluate((el) => el.contains(document.activeElement)), {
      message: "the focus never entered the overlay",
    })
    .toBe(true);

  // 2. The focus stays in, in both directions. Asserted by driving it to each
  //    end and pressing past it: the wrap is the observable behaviour, and the
  //    absence of a trap shows up here as the focus landing on the document
  //    body or on a control behind the overlay.
  const ends = await overlay.evaluate((el) => {
    const focusable = Array.from(
      el.querySelectorAll<HTMLElement>(
        "a[href],button:not([disabled]),input:not([disabled]):not([type='hidden'])," +
          "select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])",
      ),
    );
    return focusable.length;
  });
  expect(ends, "an overlay with nothing focusable in it").toBeGreaterThan(1);

  const focusEnd = (which: "first" | "last"): Promise<void> =>
    overlay.evaluate((el, pick) => {
      const focusable = Array.from(
        el.querySelectorAll<HTMLElement>(
          "a[href],button:not([disabled]),input:not([disabled]):not([type='hidden'])," +
            "select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])",
        ),
      );
      const target =
        pick === "first" ? focusable[0] : focusable[focusable.length - 1];
      target?.focus();
    }, which);

  await focusEnd("last");
  await page.keyboard.press("Tab");
  expect(
    await overlay.evaluate((el) => el.contains(document.activeElement)),
    `Tab past the last control left the overlay (focus is on ${await activeDescription(page)})`,
  ).toBe(true);

  await focusEnd("first");
  await page.keyboard.press("Shift+Tab");
  expect(
    await overlay.evaluate((el) => el.contains(document.activeElement)),
    `Shift+Tab past the first control left the overlay (focus is on ${await activeDescription(page)})`,
  ).toBe(true);

  // 3. Escape closes it and the focus comes back to what opened it. Without
  //    the restore, the focus falls to `<body>` — the top of the document — so
  //    the next Tab starts the page over, which is the failure people describe
  //    as "it lost my place".
  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();
  await expect(reopen).toBeFocused();

  await reopen.click();
  await expect(overlay).toBeVisible();
}

test.describe("Critical journey — WCAG 2.2 AA", () => {
  // Serial and long by design: this is one session walking one path, and the
  // steps are written against each other's state.
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  test("has no accessibility violations at any step", async ({
    page,
  }, testInfo) => {
    const surface = surfaceOf(testInfo.project.name);
    await installAxe(page);

    const findings: Finding[] = [];

    await walk(page, surface, async (step) => {
      await test.step(`${step.id} — ${step.title}`, async () => {
        if (step.id === "posts-create-dialog") {
          await assertModalKeyboardBehaviour(
            page,
            page.getByRole("dialog"),
            page
              .getByRole("button", { name: /new post/i })
              .filter({ visible: true }),
          );
        }
        if (step.id === "nav-drawer") {
          await assertModalKeyboardBehaviour(
            page,
            page.getByRole("dialog", { name: "Navigation" }),
            page
              .getByRole("button", { name: "Open navigation" })
              .filter({ visible: true }),
          );
        }
        findings.push(
          ...(await audit(page, {
            step: step.id,
            // Conditional spread rather than `allowIncomplete: step.allowIncomplete`:
            // `exactOptionalPropertyTypes` rejects passing `undefined` to an
            // optional property.
            ...(step.allowIncomplete && {
              allowIncomplete: step.allowIncomplete,
            }),
          })),
        );
      });
    });

    expect(
      findings,
      findings.length === 0
        ? ""
        : `${findings.length} accessibility finding(s) on ${surface}:\n\n` +
            `${formatFindings(findings)}\n`,
    ).toEqual([]);
  });
});
