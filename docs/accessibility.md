# Accessibility: the WCAG 2.2 AA gate

Status: **done** for the automated half. Every document the build prerenders is
audited with axe-core in Chromium, in both themes, against every WCAG level-A
and level-AA rule set up to 2.2. `scripts/assert-accessibility.ts` fails CI on
any violation, and on any result axe could not decide.

What the gate does _not_ cover is as important as what it does, and the second
half of this document is that list. Automated testing reaches roughly a third of
WCAG; the number people quote for axe is "about 57% of issues found in
practice", which is a statement about the issues real sites have, not about the
success criteria. The rest needs a keyboard, a screen reader and a person.

## What it checks

```
pnpm build && pnpm exec tsx scripts/assert-accessibility.ts
```

- **Every prerendered document.** 31 of them at the time of writing: the fifteen
  concrete routes, the four fallback shells for dynamic segments
  (`/blog/[slug]`, `/photos/[id]`, `/posts/[id]`, `/pricing/v/[variant]`), the
  intercepted modal slot, the seeded blog posts and photos, `/_not-found` and
  `/_global-error`. A new route is in the audit the moment it prerenders;
  `REQUIRED_DOCUMENTS` is the other direction, and fails if a route the audit
  used to cover stops producing a document.
- **Both themes.** The dark palette is a different set of colours and no
  light-mode run can speak for it. See [the finding](#what-it-found) below.
- **Rule sets** `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22a`,
  `wcag22aa`. Deliberately not `best-practice`: a gate that fails on advice
  nobody agreed to is a gate people stop running.

### Why the build output and not a running server

Every other gate in this repository reads what the build wrote, and this one has
three further reasons:

1. Those bytes are what a visitor's browser parses first, before a line of
   JavaScript has run. If the document is wrong there, it is wrong at the moment
   someone starts reading it.
2. The documents exist for routes no unauthenticated request could reach.
   Against a server, `/dashboard`, `/admin`, `/settings/security` and `/upload`
   answer with a redirect to `/login`, and the audit would silently cover
   thirteen routes instead of thirty-one.
3. They are the same bytes on every run. No database, no session, no network.

### Why a real browser

The first version of this gate ran axe in jsdom and reported the whole
application clean. It was measuring nothing. jsdom performs no layout and has no
canvas, so `color-contrast` and `target-size` — between them most of what AA
adds over A — return `incomplete` for every element on every page, and an
`incomplete` result is not a failure. The run looked identical to a passing one.

Chromium, with the build's own stylesheet served alongside the document,
evaluates both. Two things in the gate exist only to keep that true:

- `DocumentStyling` asserts, per document, that the browser parsed CSS rules at
  all and that `body` has a resolved background colour. An earlier runner
  blocked `**/_next/static/chunks/**` to stop React hydrating — and the build
  puts the **stylesheet** in `chunks/` too, so the audit ran against unstyled
  markup and reported no violations on pages that have since been shown to have
  them. Nothing in an axe result says "I was looking at the wrong document".
- `RULES_THAT_MUST_RUN` asserts that `color-contrast` and `target-size` were
  evaluated somewhere in each theme. That is the jsdom signature, checked for
  directly.

### What runs and what does not

External scripts are blocked, so nothing hydrates. The audit sees the document
as served. Inline scripts still run, which is how the theme is applied: the
runner seeds `localStorage` and `next-themes`' own inline script puts
`.light`/`.dark` on `<html>`. `themeClassApplied` is the check that keeps the
dark pass from quietly becoming a second light pass if that ever changes.

One desktop viewport, 1280×900.

## Allowances

Four, each with its reason in the source. An allowance that stops matching
anything **fails the gate** — an exemption nobody needs is a hole waiting for
the next regression — and an allowance can be pinned to a rule, a route, a theme
and a substring of the offending markup, so an exemption for one element cannot
absorb a second element failing the same rule on the same page.

| Document              | Rule             | Why                                                                                                                                                                                                                               |
| --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/_global-error`      | `html-has-lang`  | Next generates this static 500 document itself, as `<html id="__next_error__">` with no `lang`, whether or not the app defines `global-error.tsx`. Pinned to Next's own markup.                                                   |
| `/blog/[slug]`        | `document-title` | A fallback shell is prerendered before the slug exists, so `generateMetadata` has not run and the title streams into the real response. The concrete seeded posts all carry theirs.                                               |
| `/photos/[id]`        | `document-title` | The same property.                                                                                                                                                                                                                |
| `/posts/[id]`         | `bypass`         | `NavLinks` calls `usePathname`, which a shell for an unknown id cannot answer, so the nav streams and the document has no landmark yet — the same fact `assert-streaming-boundaries.ts` asserts.                                  |
| `/blog/<seeded slug>` | `color-contrast` | The video facade's caption sits on `from-black/80 to-transparent` over a thumbnail; axe reports a gradient as undecidable. Reviewed: the text is inside the ≥80%-black region, 12.6:1 against white even over the lightest frame. |

The `/_global-error` entry is the only one that is not a property of Next's
fallback shells, and the only one that cannot be fixed from this repository.
`src/app/global-error.tsx` does fix the runtime boundary, which is the document
a visitor actually lands on when the root layout throws, and it renders
`<html lang="en">` with its own styles for both colour schemes — it carries them
inline rather than importing `globals.css`, because the layout that links that
stylesheet is what just failed.

## What it found

`--primary` was `oklch(55% 0.2 250)` — `#0071df` — with no `.dark` override. On
the light background that is 4.74:1; on `oklch(9%)` it is **4.37:1**, under AA
for the 14px links that use it. Both auth pages had shipped it since the palette
was written, and no light-mode audit could have found it.

Raising it costs the other pairing, which is the part worth writing down:

| `--primary` in `.dark` | link text on background | white on primary | `oklch(9%)` on primary |
| ---------------------- | ----------------------- | ---------------- | ---------------------- |
| `oklch(55% 0.2 250)`   | 4.37 ✗                  | 4.74 ✓           | 4.37 ✗                 |
| `oklch(60% 0.2 250)`   | 5.35 ✓                  | 3.88 ✗           | 5.35 ✓                 |
| `oklch(65% 0.2 250)`   | 6.42 ✓                  | 3.23 ✗           | 6.42 ✓                 |

A brighter primary cannot keep white text on it. So the dark theme inverts
`--primary-foreground` as well, and both directions land at 6.42:1 —
`oklch(65% 0.2 250)` for the colour and `oklch(9% 0 0)` for what sits on it.
This is the ordinary shape of a dark palette, and the reason buttons in dark mode
have dark labels.

## What this gate does not cover

Not a list of things to get to eventually — a list of the claims this gate does
**not** support.

**Interaction.** Nothing is clicked, focused, or typed into. A dialog's focus
trap, a drawer's `Escape` handler, the focus ring on a control two tabs in, a
validation message announced after a failed submit: none of it is audited here.
The interactive suite is the next item in `SPEC.md`, and the one after that is
focus management across App Router navigations.

**Streamed content.** The documents are audited as served, so what sits behind a
Suspense boundary is the fallback, not the content. A table rendered after the
query returns is not in this audit.

**Touch targets at phone width.** `target-size` (2.5.8) runs, but at 1280px. It
is a touch criterion, and a narrow viewport is where it bites; that pass belongs
with the device matrix of the interactive suite.

**Most of what WCAG 2.2 added.** axe automates exactly one 2.2 rule,
`target-size`. The new criteria it cannot test, and how this application stands
against them today, by inspection rather than by gate:

- **2.4.11 Focus Not Obscured (AA)** — needs scroll position and a sticky
  header. The dashboard has a sticky sidebar, not a sticky top bar, so there is
  nothing above a focused control to hide it. Not asserted anywhere.
- **2.5.7 Dragging Movements (AA)** — nothing in the application is
  drag-operated; the image upload is a file input with a drop zone, and the
  input is the single-pointer path.
- **3.2.6 Consistent Help (A)** — no help mechanism exists, so the criterion is
  satisfied vacuously. Adding one puts it in scope.
- **3.3.7 Redundant Entry (A)** — no multi-step flow re-asks for information.
- **3.3.8 Accessible Authentication (AA)** — no CAPTCHA and no puzzle; the login
  form is email and password with `autocomplete` set, so a password manager can
  fill it. This is the criterion most likely to be broken by a future change.

**Everything a person has to judge.** Whether alternative text _says the right
thing_, whether a heading structure matches the visible structure, whether an
error message explains what to do, whether a reading order makes sense, whether
motion respects `prefers-reduced-motion` in a way a user notices. axe checks
that an `alt` exists. It cannot check that it is true.

## Running it locally

```
pnpm install
pnpm build
pnpm exec tsx scripts/assert-accessibility.ts
```

The gate launches the Chromium build pinned by `@playwright/test`
(`pnpm exec playwright install chromium` once). In a sandbox that cannot reach
`cdn.playwright.dev`, point `A11Y_CHROMIUM_PATH` at a Chromium already on disk:

```
A11Y_CHROMIUM_PATH=/path/to/chrome pnpm exec tsx scripts/assert-accessibility.ts
```

The audit's conclusions are about markup and a stylesheet, so a browser a few
builds either side of the pinned one is an honest substitute — and skipping the
gate entirely is not.

`axe-core` is pinned to an exact version rather than a range. A minor release of
it adds rules, which is a welcome change and not one that should arrive as a red
build on an unrelated pull request: bumping it is its own change, with whatever
it newly finds fixed in the same commit.
