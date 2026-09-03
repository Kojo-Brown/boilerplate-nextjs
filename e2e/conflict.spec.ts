import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Two tabs editing one post, in a real browser.
 *
 * The unit suite covers the same state machine with the Server Action mocked,
 * which is enough for the merge rules and not enough for the claim this feature
 * actually makes: that a second save *reaches Postgres*, is rejected by the
 * `WHERE version = …` on the `UPDATE`, and comes back with the other tab's row.
 * Nothing short of two live sessions against one database exercises that.
 *
 * Both tabs are the same signed-in author, which is the common case rather than
 * a contrived one — a laptop and a phone, or a tab left open since this morning.
 * Ownership is not what is being tested here; concurrency is.
 *
 * Not wired into CI: the E2E suite still needs a running server and a database,
 * which is the gap carried since Phase 0. Run it with `pnpm test:e2e
 * conflict.spec.ts` against a seeded database.
 */

const UNIQUE = Date.now().toString(36);

// Playwright's 30s default is below the ceiling `expectSaved` needs; see the
// note there for what is slow and why it is not this feature.
test.describe.configure({ timeout: 150_000 });

async function createPost(page: Page, title: string, body: string) {
  await page.goto("/posts");
  await page.getByRole("button", { name: "New Post" }).click();
  await page.getByLabel(/title/i).fill(title);
  await page.getByLabel(/content/i).fill(body);
  await page.getByRole("button", { name: "Create" }).click();

  // Scoped to the row that carries this title rather than `.first()`: the list
  // is ordered by creation time and this suite leaves posts behind, so "the
  // first Edit link" is whichever post happens to sort highest — which opened
  // the previous test's post and failed on an assertion about a title.
  const row = page.locator("article").filter({ hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Edit" }).click();
  await expect(page).toHaveURL(/\/posts\/[^/]+$/);

  return page.url();
}

async function save(page: Page) {
  await page.getByRole("button", { name: "Save changes" }).click();
}

/**
 * Waits for the save to have landed, and asserts it landed as a save.
 *
 * Two steps rather than one, because they fail differently. The button reads
 * "Saving…" and is disabled for exactly as long as the action is in flight, so
 * waiting for it to come back is the signal that the round trip *finished*.
 * Only then is the outcome checked, against a toast that has a lifetime of its
 * own and should not be raced with a request still in flight.
 *
 * The ceiling is generous, and deliberately not tuned down. A plain save with
 * no conflict anywhere near it stalls for about four seconds on perhaps a third
 * of attempts here, and occasionally for far longer — measured against this
 * same build with a single tab and no second writer, so it is a property of
 * running `next start` over a `standalone` build in a container rather than
 * anything this feature does. A tight bound would make these tests report that
 * as a conflict-resolution failure, which is the one thing they must never do.
 */
async function expectSaved(page: Page) {
  await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled({
    timeout: 60_000,
  });
  await expect(page.getByText("Post saved")).toBeVisible();
  await expect(page.getByTestId("conflict-panel")).toBeHidden();
}

test("a second save is rejected rather than overwriting, and can be merged", async ({
  page,
  context,
}) => {
  const title = `Conflict ${UNIQUE}`;
  const url = await createPost(page, title, "Original body");

  // A second tab on the same post, holding the same version.
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.getByRole("textbox", { name: /^title/i })).toHaveValue(
    title,
  );

  // The other tab retitles the post and saves first.
  await other
    .getByRole("textbox", { name: /^title/i })
    .fill(`${title} (edited)`);
  await save(other);
  await expectSaved(other);

  // This tab has been rewriting the body all along, and now saves against a
  // version that has moved. Without the check, the retitle above would be gone.
  await page.getByRole("textbox", { name: /content/i }).fill("Rewritten body");
  await save(page);

  const panel = page.getByTestId("conflict-panel");
  await expect(panel).toBeVisible();
  // Disjoint edits: they moved the title, this tab moved the body, so there is
  // nothing to choose between.
  await expect(page.getByTestId("conflict-taken")).toContainText(
    "Keeping their title",
  );
  await expect(panel.getByRole("radio")).toHaveCount(0);

  await page.getByRole("button", { name: "Apply to editor" }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("textbox", { name: /^title/i })).toHaveValue(
    `${title} (edited)`,
  );
  await expect(page.getByRole("textbox", { name: /content/i })).toHaveValue(
    "Rewritten body",
  );

  // The rebase: the merged draft saves against the version it was reconciled
  // against, so this one goes through.
  await save(page);
  await expectSaved(page);

  // Both edits survived, which is the whole point.
  await other.reload();
  await expect(other.getByRole("textbox", { name: /^title/i })).toHaveValue(
    `${title} (edited)`,
  );
  await expect(other.getByRole("textbox", { name: /content/i })).toHaveValue(
    "Rewritten body",
  );

  await other.close();
});

test("a contested field is offered as a choice", async ({ page, context }) => {
  const title = `Contested ${UNIQUE}`;
  const url = await createPost(page, title, "Original body");

  const other = await context.newPage();
  await other.goto(url);
  await other.getByRole("textbox", { name: /^title/i }).fill("Their title");
  await save(other);
  await expectSaved(other);

  await page.getByRole("textbox", { name: /^title/i }).fill("My title");
  await save(page);

  const field = page.getByTestId("conflict-title");
  await expect(field).toBeVisible();
  // Preselected on this browser's text: theirs is in the database and survives
  // not being picked; this draft is not.
  await expect(field.getByRole("radio", { name: /Keep mine/ })).toBeChecked();

  await field.getByRole("radio", { name: /Use theirs/ }).click();
  await page.getByRole("button", { name: "Apply to editor" }).click();

  await expect(page.getByRole("textbox", { name: /^title/i })).toHaveValue(
    "Their title",
  );

  await other.close();
});
