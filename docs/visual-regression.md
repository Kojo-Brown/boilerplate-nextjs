# The journey suites: accessibility and visual regression

Status: **done**. Two Playwright projects walk one critical journey —
`journey-desktop` at 1280×900 and `journey-mobile` on a Pixel 5 — and two specs
measure each state along it. `e2e/a11y-journey.spec.ts` runs axe-core and
asserts the keyboard behaviour axe has no rule for; `e2e/visual-journey.spec.ts`
compares a screenshot with a committed baseline. Both are the `Journey (a11y +
visual)` job in CI and block a merge.

```
pnpm exec playwright test --project=journey-desktop --project=journey-mobile
```

## What this adds that the static gate cannot

`scripts/assert-accessibility.ts` audits the 60 documents the build prerenders,
with external scripts blocked so nothing hydrates. That is the right way to
make a claim about the bytes a visitor parses first, and it is why the entire
interactive surface is outside it. `docs/accessibility.md` lists the gap; these
suites are that list:

| Gap                                                               | Where it is covered now                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| Interaction — a dialog, a drawer, a message after a failed submit | `register-rejected`, `posts-create-dialog`, `nav-drawer`      |
| Streamed content, rather than the Suspense fallback               | `dashboard`, whose witness waits for all three parallel slots |
| `target-size` at a width where a touch target is cramped          | the `journey-mobile` project                                  |
| A focus trap, which axe automates no rule for                     | `assertModalKeyboardBehaviour`                                |

## The journey

Eight states, in order, in one browser session. `e2e/support/journey.ts` is the
registry; both specs walk it.

| Step                  | What is being measured                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `landing`             | the public front door, hydrated                                                          |
| `register-form`       | the registration form, untouched                                                         |
| `register-rejected`   | the same form after the server refuses a duplicate email                                 |
| `login-form`          | the sign-in form                                                                         |
| `dashboard`           | the dashboard with the greeting, the session card and all three streamed panels resolved |
| `posts-list`          | the client-fetched posts list, settled                                                   |
| `posts-create-dialog` | the create-post dialog, open                                                             |
| `nav-drawer`          | the navigation drawer, open — mobile only, because it is `lg:hidden`                     |

Two things about the shape of that list are deliberate.

**It signs itself in.** There is no `storageState` and no dependency on
`auth.setup.ts`, because three of the eight states are the authentication flow
and a restored session skips all three.

**Every step carries a witness** — an assertion that must hold before anything
is measured. This is the part that keeps the suite from being decorative: an
axe run against a dialog that never opened reports no violations, and a
screenshot of a skeleton compares equal to a baseline of the same skeleton.
Both are green and neither measured anything. The witness asserts the content a
step exists to show, not merely that the page changed.

That is not hypothetical. The first version of the `dashboard` step waited for
the greeting and nothing else, so the three parallel route slots were still
showing their `Skeleton` fallbacks: the baseline recorded grey blocks, the next
run photographed the resolved panels, and the gate reported 5,883 differing
pixels. The accessibility audit had been running against those same skeletons,
which is the quieter half of the same mistake — a fallback has no table in it,
no links, and no text to fail a contrast rule.

## The baselines are recorded in CI

A screenshot baseline is only meaningful against the Chromium build and the
fonts that produced it. So the recording happens where the comparison happens:

> Push a commit with `[update-snapshots]` in its message, or run the **Update
> visual snapshots** workflow by hand. It records every image on the runner,
> commits what changed, and pushes to your branch.

The push it makes is by `github-actions[bot]` using `GITHUB_TOKEN`, which by
design does not trigger workflows — so the verification run is your _next_
push. That is the right way round: a run that recorded its own baselines and
then compared against them would be green by construction.

`scripts/assert-visual-baselines.ts` is the static half, and runs with the
cheap gates in the `build` job. It compares the journey registry with the
images on disk and fails on either direction. Playwright covers the first badly
and the second not at all: a **missing** baseline fails the run that needs it,
eventually, after a build and a database and a browser; an **orphaned** one is
silent for ever, because a renamed step leaves its `.png` behind and nothing
ever opens it again. That is the same property as an unused accessibility
allowance, failed on for the same reason.

## Determinism

Four things make a screenshot comparison reproducible here, and each of them
was a failing run first.

- **`animations: "disabled"`.** Transitions are finished and rewound before the
  shot, or the dialog's own fade is a different frame every time.
- **`caret: "hide"`.** Three states have a focused input, including the
  create-post dialog whose title field carries `autoFocus`. Without it the gate
  fails about half the time on a single one-pixel column.
- **The viewport, not `fullPage`.** A full-page image's height is a function of
  the content, so one more seeded post resizes four baselines. It is also wrong
  for an overlay: `position: fixed` in a full-page screenshot paints over the
  top slice and leaves the rest of the image as the page behind it.
- **Dates are masked.** `prisma/seed.ts` leaves `createdAt`/`updatedAt` to
  `now()`, so every date on screen is the day the database was seeded and a
  baseline outlives it by one day. The mask matches dates by shape rather than
  by class, because a mask pinned to a Tailwind utility silently stops matching
  after a restyle — and a mask that stops matching does not fail, it just
  starts comparing something volatile again.

The seed is also what keeps the _order_ of the posts stable: it inserts
sequentially, so the timestamps differ by milliseconds and `ORDER BY "createdAt"
DESC` is total. Two posts seeded inside the same millisecond would tie, and
Postgres promises no order for a tie.

### Each project is its own client

`RATE_LIMIT_RULES` gives the `/login` and `/register` Server Actions **one
shared budget of ten a minute**, keyed on the client address, and every walk of
the journey spends two of it. Four tests — two specs × two projects — spend
eight, and a single CI retry spends more than the budget has.

So each project, and each run, sends its own `x-forwarded-for` from
`2001:db8::/32`, the range reserved for documentation. This weakens nothing:
four requests still land in one bucket, so a budget that regressed to three
would still fail here. It is worth knowing about because the failure is
otherwise very hard to read — a rate-limited action comes back with no
`fieldErrors`, so its message is a toast rather than the field error the journey
is waiting for, and the symptom is "the duplicate-email message never appeared"
twenty lines from the cause. The witness says so when it fails.

## What these suites found

Five defects, every one of them invisible to the gates that were already here.

1. **The create-post dialog and the navigation drawer both declared
   `aria-modal="true"` and left the focus on the trigger behind them.** That
   attribute tells a screen reader to ignore everything outside the dialog, so
   the focused control was also the one it had been told not to announce — and
   `Tab` walked straight out into a page the same attribute had just hidden.
   Fixed in `src/hooks/use-modal-focus.ts`: focus in, focus kept in, focus
   returned. axe automates no focus-trap rule, every attribute was individually
   correct, and jsdom has no sequential focus navigation at all — so no unit
   suite could have failed on it either.
2. **`hover:opacity-90` on the primary button dropped white-on-primary to
   4.05:1**, under AA, for as long as the pointer was on the control. An
   opacity is a blend with whatever is behind the button, so a hover state
   expressed that way moves the text's contrast and no review of the markup
   shows it. Replaced with `--primary-hover`, a colour: darker in the light
   theme and lighter in the dark one, which is the same inversion
   `--primary-foreground` already makes and for the same reason.
3. **`aria-controls="mobile-drawer"` pointed at nothing.** The drawer panel had
   no id. axe skips that check while `aria-expanded` is `false`, on the
   reasonable assumption that a collapsed control may not have rendered its
   target yet, so nothing caught it until a suite opened the drawer.
4. **The login and registration forms both used `id="email"` and
   `id="password"`.** Next keeps the route you navigated away from mounted and
   hidden so Back can be instant, so on `/register` the whole of `/login` is
   still in the document — and a label's `for` resolves to the _first_ match,
   which is the hidden form's input. Clicking "Email" on `/register` focused
   something on `/login`.
5. **The avatar's `aria-label` was on a bare `<div>`**, where it is a prohibited
   attribute: there is no role to hang a name on, so the label is dropped and
   the element is announced as its text content, which is two letters. It is
   `role="img"` now. The static gate never saw it, because an avatar needs a
   session and a prerendered document has no user in it.

## What these suites do not cover

- **The rest of the application.** Eight states on one path. `/blog`,
  `/photos`, `/pricing`, `/upload`, `/images`, `/admin` and
  `/settings/security` are audited as prerendered documents and are not
  interacted with. The photo modal is an intercepting route with end-to-end
  behavioural coverage in `e2e/photos.spec.ts`, but its _open_ state is not
  audited here.
- **Hover states other than the two buttons this journey touches.**
  `hover:opacity-80` appears on about a dozen other controls. Most are text on
  a transparent background, where the blend costs contrast that is nowhere near
  the threshold — but `blog/[slug]`'s "back" link is `--primary`-coloured, and
  that pairing starts at 4.74:1. Nothing checks it.
- **One locale.** The journey runs in `en`. The `ar` route tree is audited as
  documents, including its RTL layout, but nothing clicks through it.
- **One theme.** The static gate audits both; these suites run in whatever the
  default resolves to. A dark-mode interaction state is not covered.
- **Anything a person has to judge.** A screenshot comparison reports that
  pixels changed. It has no opinion on whether the change was an improvement,
  and it is just as happy to lock in a layout that was wrong when it was
  recorded.

## Reviewing a baseline change

The diff is images, and an image changing is not evidence of anything on its
own. Download the `playwright-report` artifact from a failed run — it carries
the actual, expected and diff triple, which is the only form in which a visual
failure is reviewable at all; "5,883 pixels differ" tells nobody whether that
is a regression or an intended restyle.

If the change is intended, re-record and say in the pull request what moved and
why. If it is not, the gate has done its job.

## Running it locally

```
pnpm install
pnpm build
pnpm exec playwright install chromium   # once
pnpm exec playwright test --project=journey-desktop --project=journey-mobile
```

It needs a seeded database and a build, the same as the CI job: `prisma db
push`, `pnpm db:rls`, `pnpm db:seed`. Playwright starts the server itself.

In a sandbox that cannot reach `cdn.playwright.dev`, point
`PLAYWRIGHT_CHROMIUM_PATH` at a Chromium already on disk — the same hatch
`A11Y_CHROMIUM_PATH` gives the static gate:

```
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome pnpm exec playwright test --project=journey-desktop
```

That is an honest substitute for the accessibility half, whose conclusions are
about markup and a stylesheet. It is **not** one for the visual half: a
different Chromium rasterises text differently, so every image will differ.
Record baselines through the workflow, not from there.
