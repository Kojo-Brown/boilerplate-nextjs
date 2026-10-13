# Focus management across App Router navigations

Status: **done**. A skip link, one focusable `<main>` landmark per route, and a
focus manager mounted in the root layout that moves the keyboard focus on every
client-side navigation. `scripts/assert-focus-management.ts` fails CI if any of
that comes apart; `e2e/focus-management.spec.ts` is where the claims a browser
has to answer are made.

## The defect

`<Link>` replaces the document's content without reloading it, and nothing in
that process touches the focus. On a full page load the browser resets focus to
the top of the new document; on a client-side navigation it does not, so focus
stays on whatever was activated — which, on a route with persistent chrome, is
a link in the sidebar that is still there.

For a mouse user, nothing. For everyone else:

- **Keyboard.** The next Tab continues from the middle of the navigation, not
  from the top of the page that just loaded. Every route change leaves the
  visitor further from the content than the one before.
- **Screen reader.** The virtual cursor does not move, so the new page is not
  read. The reader announces the document title — Next does that much, see
  [Announcements](#announcements) — and then says nothing else until the
  visitor goes looking.

WCAG 2.4.3 (Focus Order, level A) is the criterion. The symptom is that
keyboard navigation of a single-page application silently stops working after
the first navigation, and no automated audit of the markup can see it: the
accessibility gate audits 31 documents and every one of them is clean.

## The three pieces

### `<SkipLink>` — `src/components/a11y/skip-link.tsx`

A plain `<a href="#main-content">`, first in `<body>`, visually hidden until
focused. Not a `<Link>`: the href is a same-document fragment that the browser
resolves itself, so routing it through the router would make the first control
a keyboard user reaches depend on JavaScript having loaded — which is exactly
the window in which someone tabbing straight after a page load is using it.

Two things about it are load-bearing and neither is visible to a mouse:

- **Position.** A skip link that comes after the navigation it exists to skip
  is decoration. It is above `<ThemeProvider>` rather than inside it because
  the providers are where a wrapper gets added, and a wrapper that renders a
  banner or a layout grid above its children would move the skip link down
  without anyone editing the root layout. Rule R5 of the gate asserts the
  position in the build output for that reason, not in the source.
- **`sr-only`, not `display: none`.** Both `display: none` and
  `visibility: hidden` take an element out of the tab order entirely, so a
  skip link hidden either way is unreachable. It is a clip-and-offset that
  `focus:not-sr-only` undoes, which also makes it _visible_ when focused — a
  sighted keyboard user otherwise watches focus vanish for one Tab.

### `<MainContent>` — `src/components/a11y/main-content.tsx`

`<main id="main-content" tabIndex={-1}>`, and every route goes through it. A
Server Component; both attributes are static.

`tabIndex={-1}` is the counter-intuitive one, because the usual reason to write
it is to take something _out_ of the tab order. `<main>` is not in the tab
order to begin with; what the attribute adds is the ability to be focused at
all — programmatically, or as a fragment target. Without it, `#main-content`
scrolls the element into view and leaves focus on `<body>`, so the skip link
moves the viewport and not the keyboard and the next Tab goes back to the
second link in the header. This is the single most common way a skip link ships
broken and it passes every eye test.

Adding it found two routes with no landmark at all: `/login` and `/register`
rendered a centred `<div>`, so the skip link had nowhere to go on the first
page a signed-out visitor sees. `/_not-found` was worse — it inherited the root
layout, so it _had_ the skip link, and fell back to Next's built-in 404, which
has no `<main>`. `src/app/not-found.tsx` exists for that reason and `/_not-found`
is in the gate's `REQUIRED_DOCUMENTS` so that deleting it fails the build
rather than silently restoring the built-in.

### `<RouteFocus>` — `src/components/a11y/route-focus.tsx`

Mounted once, in the root layout, renders `null`. The policy it applies is in
`src/lib/a11y/route-focus.ts` and is a pure function of six inputs, which is
where it is tested; the component is the three observations that policy needs.

| Situation                                           | What happens   | Why                                                                                                                                                                     |
| --------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First render                                        | nothing        | A full page load already focused the document, and the reader is reading the page that was asked for. Moving the cursor here skips the heading and the skip link.       |
| Search params changed, pathname did not             | nothing        | `/posts?page=1` and `?page=2` are the same pathname. Moving focus out of the paginator the visitor just operated is how that control becomes unusable.                  |
| URL carries a `#fragment`                           | nothing        | The browser has its own target. This is also what the skip link produces, so without the rule, activating it would be followed by a redundant focus move a frame later. |
| A dialog has claimed the focus                      | nothing        | See [Dialogs](#dialogs-and-the-intercepted-modal-route).                                                                                                                |
| Back / Forward, with a focusable element remembered | focus it       | Returning to where you were. Dismissing the photo modal hands focus back to the tile that opened it.                                                                    |
| Back / Forward, with nothing to restore             | focus `<main>` |                                                                                                                                                                         |
| Anything else                                       | focus `<main>` |                                                                                                                                                                         |

Two implementation details are not decoration, and both were found by running
the suite in a real browser rather than in jsdom.

**`popstate` arrives after the commit.** Back and `router.back()` are the only
navigations that should restore focus rather than reset it, and the router does
not distinguish them: `usePathname` reports the destination identically either
way. `popstate` does — but Next registers its own listener before this one and
dispatches the router update from inside it, and React flushes a `popstate`
update synchronously. So the effect body for the popped route runs _inside_
Next's handler, several listeners before ours is reached, and a flag read there
is always `false`. It is read in the deferred callback instead. The unit suite
had set the flag and then re-rendered, which is the one order that cannot
happen; it now covers both.

**`usePathname()` changes before the destination exists.** It reports the new
route as soon as the transition starts, while the DOM is still the previous
page's — and React hides outgoing content with `display: none`, which makes
`focus()` a silent no-op on an element that is still in the document and still
answers to `getElementById`. A single `requestAnimationFrame` therefore focused
the _outgoing_ landmark and reported success. So the move is a bounded retry:
attempt, check `document.activeElement`, and try again next frame for up to a
second, stopping early if the visitor presses a key or a pointer, or if a
dialog claims the focus. `focus()` neither throws nor returns anything, so
reading `activeElement` afterwards is the only way to know it worked.

Everything is focused with `preventScroll: true`. The router owns the scroll
position; focusing scrolls into view by default, and two things deciding where
the viewport sits is reported as a scroll bug rather than an accessibility one.

## Dialogs and the intercepted modal route

Navigating from `/photos` to `/photos/<id>` renders the intercepting route into
the `@modal` slot. That is simultaneously a route change — so `<RouteFocus>`
wants the landmark — and a dialog opening, so `<PhotoModal>` wants the dialog.
Both are right about their own half, and nothing in React's effect ordering
arbitrates: `<RouteFocus>` is a _sibling_ of the `@modal` slot, not an ancestor,
so there is no provider position a context could be read from on both sides.

`src/lib/a11y/focus-ownership.ts` is a module-scoped claim, held by the
component that performs the competing move. It is a count rather than a flag,
because a confirmation dialog opened from inside the photo modal must not hand
focus back to the router when the inner one closes, and the release is
idempotent because React invokes an effect cleanup twice under Strict Mode.

The honest limitation: on this route the modal arrives as a _streamed hole_, so
the claim lands several frames after the pathname changed, and `<RouteFocus>`
has usually already put focus on the gallery's landmark by then. The dialog's
own focus call is what settles it, so the end state is correct — asserted in
`e2e/focus-management.spec.ts` — at the cost of one extra focus event, which a
screen reader may voice as "main region" before "dialog". The claim is re-read
on every retry attempt rather than once, so it does win whenever the dialog is
mounted at decision time; it simply cannot win a race against data it is
waiting for. Closing that gap means knowing a route will render a modal before
its payload arrives, which is routing knowledge the root layout should not
have.

Restoration on dismissal works because the gallery under a parallel route slot
is never unmounted, so the tile is the same DOM node. It works for the visitor
who opened the modal **from the keyboard**, which is the visitor it exists for:
a mouse click leaves the element focused in Chrome but a keyboard activation is
the case that must not lose its place. Either way nobody is trapped.

## Announcements

This application adds **no live region of its own**, and that is a decision
rather than an omission.

Next's App Router already renders one. `AppRouterAnnouncer` appends a
`<next-route-announcer>` element to `<body>`, with an `aria-live="assertive"`
`role="alert"` region inside a shadow root, and announces `document.title` on
every client navigation but the first. A second region announcing the same
destination would mean every route change is spoken twice — which is worse than
no announcement, and is the usual result of adding a route announcer to a
framework that already has one.

What this feature adds instead is the focus move, and the focus move _is_ the
other half of the announcement: a screen reader that is sent to `<main>` reads
the region and then the heading inside it, which is the page. Title from the
live region, content from the cursor.

That makes Next's announcer a dependency worth pinning rather than assuming, so
`e2e/focus-management.spec.ts` reads the text out of its shadow root after a
navigation and asserts the destination is in it. If a future Next release drops
the announcer, that test fails and the announcement becomes ours to own —
rather than disappearing quietly, which is how an accessibility feature is
usually lost.

## The gate

```
pnpm build && pnpm exec tsx scripts/assert-focus-management.ts
```

Six rules. R1–R3 read the source, because that is where the wiring is; R4–R6
read the documents under `.next/server/app`, because the source cannot tell you
what composition produced.

- **R1** The root layout renders `<SkipLink>` and `<RouteFocus>`.
- **R2** No module renders a raw `<main>`. Two exemptions, each in
  `RAW_MAIN_ALLOWED` with its reason: the landmark component itself, and
  `global-error.tsx`, which replaces the root layout rather than nesting in it
  and so has no skip link to be the target of.
- **R3** The focus manager is a `"use client"` module, reads `usePathname`
  behind a hydration gate (see below), and focuses with `preventScroll`.
- **R4** Every audited document has exactly one `#main-content`, it is a
  `<main>`, and it carries `tabindex="-1"`.
- **R5** The skip link exists and no focusable element precedes it.
- **R6** Every document the gate used to cover is still being built.

Five documents are exempt, each because of a property of the document rather
than of this application: `/_global-error`, which Next generates itself outside
the root layout, and the four `/(.)photos/*` interception shells, whose
prerendered body is the skip link and two streamed holes and which are only
ever served into a document that already has the gallery's landmark. An
allowance that stops matching anything fails the gate, for the same reason the
accessibility gate's do.

### Why `<RouteFocus>` waits for hydration

`usePathname()` cannot be answered while prerendering a _fallback shell_ — the
document a dynamic segment builds for params it has not seen — so a client
component that calls it suspends during the build. At the root of the tree that
takes the root of `/blog/[slug]`, `/photos/[id]`, `/posts/[id]` and
`/pricing/v/[variant]` with it and prerenders those four shells empty: the
failure `assert-streaming-boundaries.ts` exists to catch, caused by an
accessibility component. `NavLinks` has the same property for the same reason;
see docs/streaming.md.

A `<Suspense fallback={null}>` around it was the first fix and it is the wrong
one. It contains the suspension, and leaves a pending boundary with an empty
fallback in every one of those shells — which the same gate fails on, also
correctly, because a hole with nothing in it paints as collapsed space and then
pushes the page around when it fills. That gate caught it on the first full
run, which is the whole point of having it.

So the hook is simply not rendered until the client exists: `<RouteFocus>`
returns `<RouteFocusEffects />` only once `useIsHydrated()` is true. No
boundary, no suspension, nothing lost — there are no client-side navigations
before the client exists, and the manager's first render is a no-op by design.
Rule R3 of the gate asserts the hydration gate, so re-introducing a bare
`usePathname()` here fails on this feature's own gate rather than three gates
later.

## What this does not cover

- **Focus inside a route.** A form that moves focus to its first invalid field
  after a failed submit, a combobox's active option, a table's roving tabindex:
  all of that is a component's own business and none of it is here.
- **A focus trap.** `<DialogContent>` sets `aria-modal="true"` and handles
  Escape, and `<PhotoModal>` moves focus into the dialog, but nothing stops Tab
  from walking out of it into the page behind. That is a dialog change, not a
  routing one.
- **Scroll restoration.** Next does not restore the scroll offset on Back in
  this configuration. `preventScroll` means focus management does not make that
  worse; it does not fix it. The e2e suite records the current behaviour so that
  a change in it is visible.
- **Reading order and heading structure.** Focus lands on the landmark; whether
  what follows is in a sensible order is a judgement, and
  docs/accessibility.md's list of what no gate can answer still applies.

## Running it locally

```
pnpm install
pnpm build
pnpm exec tsx scripts/assert-focus-management.ts
pnpm test -- a11y
pnpm exec playwright test focus-management   # needs the build and a database
```

The end-to-end spec is not run by CI — there is no end-to-end job in
`.github/workflows/ci.yml`, as with the other twelve specs in `e2e/`. The
claims it makes are the ones jsdom cannot answer, and two of them were wrong
until it was run: a fragment navigation is not implemented in jsdom at all, and
neither `checkVisibility` nor a meaningful `offsetParent` exists there, so the
hidden-outgoing-page problem is invisible to the unit suite by construction.
