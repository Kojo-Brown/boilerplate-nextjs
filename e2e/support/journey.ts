/**
 * The critical journey, written once and walked by two suites.
 *
 * `a11y-journey.spec.ts` audits each state with axe and asserts the keyboard
 * behaviour axe cannot see; `visual-journey.spec.ts` photographs the same
 * states and compares them with a committed baseline. They share this file
 * because the alternative is two lists of steps that drift, and the first thing
 * to go missing is a state from one of them — which looks exactly like a
 * passing suite.
 *
 * ## It is a journey and not a list of pages
 *
 * `arrive` for a step assumes the browser is in the previous step's state. The
 * sequence signs in, so it starts unauthenticated and nothing here depends on
 * `auth.setup.ts`: the authentication *is* the journey, and a stored session
 * would skip the two states most likely to be broken. That is also why the
 * steps are ordered and why the specs walk them with `test.step` rather than
 * turning each one into an independent test.
 *
 * ## Every step carries a witness
 *
 * `witness` is an assertion that must hold before anything is measured, and it
 * is the load-bearing part of this file. An axe run against a dialog that never
 * opened reports no violations, and a screenshot of a skeleton compares equal
 * to a baseline of the same skeleton. Both are green, both measure nothing, and
 * nothing in either result says so. The witness is the only thing standing
 * between this suite and that, so it asserts the *content* a step exists to
 * show — the resolved greeting rather than its `Skeleton`, the error paragraph
 * rather than the form that would have produced it.
 *
 * ## The seeded user, not a registered one
 *
 * The sign-in step uses `prisma/seed.ts`'s demo account. Registering a fresh
 * user per run would write a row per run, and the second run would then be
 * asserting against "email already taken" instead. The rejected-submit step is
 * on `/register` for the opposite reason: a password the schema refuses creates
 * nothing, so that state is reachable as often as you like and leaves no trace.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { IncompleteAllowance } from "./axe.js";

/**
 * Which width a step applies to.
 *
 * The navigation drawer is `lg:hidden`, so it exists at one width and not the
 * other — a step is not automatically meaningful at both.
 */
export type Surface = "desktop" | "mobile";

export const SURFACES: readonly Surface[] = ["desktop", "mobile"];

/**
 * The Playwright project that walks each width.
 *
 * Here rather than only in `playwright.config.ts`, because three things need to
 * agree on these names: the config that defines the projects, the snapshot path
 * template that files baselines under them, and
 * `scripts/assert-visual-baselines.ts`, which works out which `.png` files
 * ought to exist. A string literal in three places is a rename that half
 * happens, and the half that does not happen is a gate that quietly stops
 * checking anything.
 */
export const PROJECT_FOR_SURFACE: Readonly<Record<Surface, string>> = {
  desktop: "journey-desktop",
  mobile: "journey-mobile",
};

/**
 * The seeded demo account. Obviously-fake values that match `prisma/seed.ts`;
 * overridable so a non-seeded environment can point the suite at its own.
 */
const USER_EMAIL = process.env["E2E_USER_EMAIL"] ?? "ada@example.com";
const USER_PASSWORD =
  process.env["E2E_USER_PASSWORD"] ?? "demo-password-not-for-real-use";
const USER_NAME = process.env["E2E_USER_NAME"] ?? "Ada Example";

/**
 * A password the schema accepts, used for a submit that is meant to fail for a
 * different reason. Obviously fake, and never stored: the account it would
 * belong to already exists.
 */
const VALID_UNUSED_PASSWORD = "journey-probe-password";

export interface JourneyStep {
  /**
   * Stable, kebab-case, and the name of this step's baseline image. Renaming
   * one orphans a `.png`, which `scripts/assert-visual-baselines.ts` reports.
   */
  readonly id: string;
  /** What the step is, for the report. */
  readonly title: string;
  readonly surfaces: readonly Surface[];
  /**
   * Drives the browser from the previous step's state into this one.
   *
   * It takes the width, because reaching a state is not width-independent in a
   * responsive application: the dashboard navigation is a sidebar at 1280px and
   * lives inside the drawer below `lg`, so "click Posts" is one action on one
   * and three on the other. The *state* being measured is the same either way,
   * which is why this is a parameter of the route in rather than two steps.
   */
  readonly arrive: (page: Page, surface: Surface) => Promise<void>;
  /** Must hold before anything is measured. See the note above. */
  readonly witness: (page: Page, surface: Surface) => Promise<void>;
  /**
   * Regions whose pixels legitimately differ between runs, excluded from the
   * screenshot comparison. Keep this as small as the thing that moves.
   */
  readonly mask?: (page: Page) => readonly Locator[];
  readonly allowIncomplete?: readonly IncompleteAllowance[];
}

/**
 * Narrows a locator to the elements a visitor can actually see.
 *
 * Every selector in this file goes through it, and the reason is a property of
 * the router rather than of any page here: Next keeps the route you navigated
 * away from **mounted and hidden** so that Back can be instant. So on
 * `/register`, the whole of `/login` is still in the document — its email
 * input, its password input, its submit button — and an unqualified
 * `getByLabel("Email")` resolves to two elements and fails strict mode.
 *
 * This surfaced the moment the two forms stopped sharing input ids. While both
 * used `id="email"`, `getByLabel` had exactly one element to find, because a
 * label's `for` resolves to the first match in the document and the second
 * input had no label pointing at it — the duplicate id was *hiding* the
 * ambiguity, and in the direction that matters: the visible form's label
 * pointed at the hidden form's input, so clicking "Email" on `/register`
 * focused something on `/login`. `duplicate-id-aria` is how
 * `e2e/a11y-journey.spec.ts` found it, and this is the half of the fix that
 * lives in the suite.
 */
const visible = (locator: Locator): Locator =>
  locator.filter({ visible: true });

const themeToggle = (page: Page): Locator =>
  visible(page.getByRole("button", { name: /theme/i })).first();

const drawer = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Navigation" });

/** A form field on the page in front of the visitor. */
const field = (page: Page, label: string): Locator =>
  visible(page.getByLabel(label));

/** A control on the page in front of the visitor. */
const button = (page: Page, name: RegExp | string): Locator =>
  visible(page.getByRole("button", { name }));

const link = (page: Page, name: RegExp | string): Locator =>
  visible(page.getByRole("link", { name }));

/**
 * Follows a dashboard navigation link, from wherever that link is at this
 * width.
 *
 * Below `lg` the sidebar is not rendered at all and `NavLinks` is only inside
 * the drawer, so the mobile path is open-drawer → click → the drawer closes
 * itself (`NavLinks` is given `onNavigate={onClose}`). Going straight to
 * `page.goto()` would have been shorter and would have measured a cold
 * document instead of the client-side navigation every other step performs.
 */
async function followNavLink(
  page: Page,
  surface: Surface,
  name: RegExp,
): Promise<void> {
  if (surface === "mobile") {
    await button(page, "Open navigation").click();
    await expect(drawer(page)).toBeVisible();
    await drawer(page).getByRole("link", { name }).first().click();
    await expect(drawer(page)).toBeHidden();
    return;
  }
  await link(page, name).first().click();
}

/**
 * The metadata line under a post's title: `author · date`.
 *
 * The date is the moment the seed ran, so it is different on any day the
 * baseline was not recorded. `prisma/seed.ts` does not pin `createdAt`, and
 * pinning it there would change data several other gates assert on, so the line
 * is masked here instead. It is one `<p>` per row and the author's name goes
 * with it; the titles, the published badges and every control stay in the
 * comparison.
 */
const postMetadata = (page: Page): readonly Locator[] => [
  visible(page.getByRole("article")).locator("p"),
];

/**
 * Anything on screen that is a date.
 *
 * The dashboard's two streamed panels both render one — the recent-posts list
 * in a `<time>`, the notifications widget in its body text and its timestamp —
 * and both come from `createdAt`/`updatedAt`, which `prisma/seed.ts` leaves to
 * `now()`. So they are the day the database was seeded, and a baseline recorded
 * on one day fails on the next for no reason anyone can act on.
 *
 * Matched by shape rather than by class, because the alternative is three
 * selectors pinned to Tailwind utilities that a restyle would silently detach —
 * and a mask that stops matching does not fail, it just starts comparing
 * something volatile again. Everything else in those panels, the titles and the
 * counts and the layout, stays in the comparison.
 *
 * The seed is also what keeps the *order* of those rows stable: it inserts
 * sequentially, so the timestamps differ by milliseconds and `ORDER BY
 * "createdAt" DESC` is total. Two posts seeded inside the same millisecond
 * would tie, and Postgres does not promise an order for a tie.
 */
const dates = (page: Page): readonly Locator[] => [
  page.locator("time"),
  page.getByText(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/),
];

export const JOURNEY: readonly JourneyStep[] = [
  {
    id: "landing",
    title: "the public landing page",
    surfaces: SURFACES,
    arrive: async (page) => {
      await page.goto("/");
    },
    witness: async (page) => {
      await expect(
        visible(
          page.getByRole("heading", { level: 1, name: "Next.js Boilerplate" }),
        ),
      ).toBeVisible();
      // Hydration, asserted rather than waited for: the theme control is a
      // client component whose label is the neutral placeholder until it
      // mounts. Every step after this one clicks something, and a click
      // dispatched before hydration is a click into a static document.
      await expect(themeToggle(page)).toHaveAttribute("aria-label", /theme$/i);
    },
  },
  {
    id: "register-form",
    title: "the registration form, untouched",
    surfaces: SURFACES,
    arrive: async (page) => {
      await link(page, /sign in/i)
        .first()
        .click();
      await link(page, /create one/i).click();
      await expect(page).toHaveURL(/\/register$/);
    },
    witness: async (page) => {
      await expect(field(page, "Name")).toBeVisible();
      await expect(button(page, /create account/i)).toBeEnabled();
    },
  },
  {
    id: "register-rejected",
    title: "the registration form after a rejected submit",
    surfaces: SURFACES,
    // A duplicate email, and that choice is not arbitrary — it is the only
    // server-side field error this form can actually be made to show.
    //
    // Every other one is unreachable through a browser, because the inputs
    // carry the same constraints the schema does: `required` on all three,
    // `type="email"` on the address and `minLength={8}` on the password. The
    // first draft of this step submitted a seven-character password and spent a
    // while failing, because constraint validation refuses the submit and the
    // Server Action is never called. "Already registered" is the one answer
    // only the server knows.
    //
    // It is also the only error state here with no clock on it. A rejection
    // without `fieldErrors` goes to `toast.error`, and a toast dismisses itself
    // after four seconds — fine to catch once, worthless as a baseline image.
    // This one is a paragraph in the form and stays until something changes.
    arrive: async (page) => {
      await field(page, "Name").fill("Journey Probe");
      await field(page, "Email").fill(USER_EMAIL);
      await field(page, "Password").fill(VALID_UNUSED_PASSWORD);
      await button(page, /create account/i).click();
    },
    witness: async (page) => {
      // The server's answer, not the browser's: the form passed constraint
      // validation, round-tripped through the Server Action, and came back with
      // `fieldErrors.email`. Waiting for that text is what proves this is the
      // post-submit state and not the one before it.
      await expect(
        visible(page.getByText("This email is already registered.")),
        "the registration form came back without its duplicate-email error. " +
          "The usual cause is the authentication rate limit — ten requests a " +
          "minute shared by the /login and /register Server Actions — which " +
          "answers with no `fieldErrors` at all, so the message arrives as a " +
          "toast and this field error never renders. " +
          "`clientIdentity` in playwright.config.ts is what keeps the " +
          "projects out of each other's budget.",
      ).toBeVisible();
    },
  },
  {
    id: "login-form",
    title: "the sign-in form",
    surfaces: SURFACES,
    arrive: async (page) => {
      await link(page, /sign in/i)
        .first()
        .click();
      await expect(page).toHaveURL(/\/login$/);
    },
    witness: async (page) => {
      await expect(field(page, "Email")).toBeVisible();
      await expect(button(page, /^sign in$/i)).toBeEnabled();
    },
  },
  {
    id: "dashboard",
    title: "the dashboard with its streamed session content resolved",
    surfaces: SURFACES,
    arrive: async (page) => {
      await field(page, "Email").fill(USER_EMAIL);
      await field(page, "Password").fill(USER_PASSWORD);
      await button(page, /^sign in$/i).click();
      await page.waitForURL(/\/dashboard$/, { timeout: 30_000 });
    },
    witness: async (page) => {
      await expect(
        visible(page.getByRole("heading", { level: 1, name: /dashboard/i })),
      ).toBeVisible();
      // The point of this step. Both halves of the page sit behind their own
      // Suspense boundary, and the fallback is a `Skeleton` with no text in it
      // — so the static audit, which sees the document as served, has only ever
      // seen the skeletons. Asserting the greeting *text* is what makes this
      // the audit of the resolved content.
      // The title is part of "the dashboard has arrived", and asserting it here
      // removes a race rather than papering over one. Sign-in lands on this
      // route through a client-side navigation, so `document.title` is written
      // by Next after the commit — an audit that ran in between reported
      // `document-title` against a page whose title was one tick away. It
      // reproduced on mobile and not on desktop, which is the signature of a
      // race and not of a defect.
      await expect(page).toHaveTitle(/Dashboard/);
      await expect(
        visible(page.getByText(`Welcome back, ${USER_NAME}!`)),
      ).toBeVisible();
      await expect(visible(page.getByText(USER_EMAIL)).first()).toBeVisible();

      // The three parallel route slots, each of which streams independently of
      // the greeting above and of each other. Leaving them out is what the
      // first version of this step did, and the visual baseline recorded their
      // `Skeleton` fallbacks — grey blocks where a panel goes — while the next
      // run photographed the resolved panels and reported 5,883 differing
      // pixels. The accessibility audit had been running against those same
      // skeletons, which is the quieter half of the same mistake: a fallback
      // has no table in it, no links and no text to fail a contrast rule.
      await expect(visible(page.getByText("Total Posts"))).toBeVisible();
      await expect(
        visible(page.getByRole("heading", { name: /recent posts/i })),
      ).toBeVisible();
      await expect(
        visible(page.getByText("Welcome to your dashboard")),
      ).toBeVisible();
    },
    mask: dates,
  },
  {
    id: "posts-list",
    title: "the posts list",
    surfaces: SURFACES,
    arrive: async (page, surface) => {
      await followNavLink(page, surface, /^posts$/i);
      await expect(page).toHaveURL(/\/posts$/);
    },
    witness: async (page) => {
      // The list is fetched on the client, so an empty frame is a perfectly
      // ordinary intermediate state; the row is what says the query settled.
      await expect(visible(page.getByRole("article")).first()).toBeVisible();
      await expect(button(page, /new post/i)).toBeEnabled();
    },
    mask: postMetadata,
  },
  {
    id: "posts-create-dialog",
    title: "the create-post dialog, open",
    surfaces: SURFACES,
    arrive: async (page) => {
      await button(page, /new post/i).click();
    },
    witness: async (page) => {
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("heading", { name: /create post/i }),
      ).toBeVisible();
    },
    mask: postMetadata,
  },
  {
    id: "nav-drawer",
    title: "the navigation drawer, open",
    // `lg:hidden`: at 1280px the trigger is not rendered, so there is no
    // desktop state to audit or photograph.
    surfaces: ["mobile"],
    arrive: async (page) => {
      // The dialog from the previous step is modal and locks body scroll;
      // closing it first is what makes this step's state the drawer's and not
      // a stack of two overlays.
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();
      await button(page, "Open navigation").click();
    },
    witness: async (page) => {
      await expect(drawer(page)).toBeVisible();
      await expect(
        drawer(page).getByRole("button", { name: "Close navigation" }),
      ).toBeVisible();
    },
    mask: postMetadata,
  },
];

/** The steps that apply at a given width, in journey order. */
export function stepsFor(surface: Surface): readonly JourneyStep[] {
  return JOURNEY.filter((step) => step.surfaces.includes(surface));
}

/**
 * Walks the journey at one width, calling `measure` once each step's witness
 * holds.
 *
 * `arrive` is written against the previous step's state, so the steps that do
 * not apply at this width can only be dropped if there is nothing after them
 * that does — otherwise the next step is being driven from a state that never
 * happened, which presents as a selector that does not resolve and sends
 * whoever reads it looking in the wrong file. `nav-drawer` is mobile-only and
 * last, so that holds today; it is checked rather than remembered, because the
 * commit that stops it holding is the one that inserts a width-specific step in
 * the middle and it will not look like this.
 */
export function assertSurfaceOrdering(surface: Surface): void {
  const lastApplicable = JOURNEY.reduce(
    (last, step, index) => (step.surfaces.includes(surface) ? index : last),
    -1,
  );
  const skippedBefore = JOURNEY.filter(
    (step, index) => index < lastApplicable && !step.surfaces.includes(surface),
  );
  if (skippedBefore.length === 0) return;
  throw new Error(
    `journey: ${skippedBefore.map((step) => step.id).join(", ")} ` +
      `do(es) not apply on ${surface} but precede(s) a step that does. ` +
      `A step's \`arrive\` assumes the previous step ran, so a gap in the ` +
      `middle of the walk drives the next step from a state that never ` +
      `existed. Move the width-specific step to the end of JOURNEY, or give ` +
      `it an \`arrive\` that does not depend on being reached in order.`,
  );
}

export async function walk(
  page: Page,
  surface: Surface,
  measure: (step: JourneyStep) => Promise<void>,
): Promise<void> {
  assertSurfaceOrdering(surface);
  for (const step of stepsFor(surface)) {
    await step.arrive(page, surface);
    await step.witness(page, surface);
    await measure(step);
  }
}
