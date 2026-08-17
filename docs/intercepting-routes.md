# Intercepting routes: a modal with a shareable URL

`/photos` is a gallery. Clicking a photo opens it in a modal and the address
bar changes to `/photos/<id>`. Reloading that URL, opening it in a new tab, or
sending it to someone renders a full page instead. Both are the same route.

That is the whole feature, and it is worth being precise about why it needs
router support rather than a `useState` dialog.

## What a client-side modal cannot do

A modal built from component state has no URL. Everything that follows from
that is a real defect, not a nitpick:

|                                | client-state dialog                 | intercepting route              |
| ------------------------------ | ----------------------------------- | ------------------------------- |
| Share what you are looking at  | impossible — the URL is the gallery | the URL is the photo            |
| Reload                         | modal disappears                    | photo is still there, as a page |
| Back button                    | leaves the gallery entirely         | closes the modal                |
| Open in new tab / middle-click | nothing to open                     | the full page                   |
| Deep link from an email        | lands on the gallery                | lands on the photo              |

An intercepting route gets all of these by making the modal a _navigation_ that
the router chooses to render differently depending on how you arrived.

## The file layout

```
src/app/
├── layout.tsx                     # renders {children} and {modal}
├── @modal/
│   ├── default.tsx                # null — every URL that is not a photo
│   └── (.)photos/[id]/page.tsx    # the modal (soft navigation only)
└── photos/
    ├── page.tsx                   # the gallery
    ├── layout.tsx                 # public chrome
    ├── [id]/page.tsx              # the full page (hard navigation)
    └── _components/
        ├── photo-grid.tsx         # tiles — real <Link>s
        ├── photo-detail.tsx       # the one rendering, shared by both routes
        ├── photo-modal.tsx        # the overlay; dismiss = router.back()
        └── copy-link-button.tsx
```

Two pieces do the work:

- **`@modal`** is a _parallel route slot_. `app/layout.tsx` receives it as a
  `modal` prop and renders it alongside `children`, so the modal and the page
  underneath are mounted at the same time. That is what keeps the gallery
  visible behind the overlay.
- **`(.)photos/[id]`** is the _interception marker_. `(.)` means "match
  `photos/[id]` at the same routing level as this slot". `@modal` sits at the
  application root, so the target is `app/photos/[id]` — the sibling of
  `@modal`, regardless of how deep the interceptor file itself is on disk.

The markers are `(.)` for the same level, `(..)` for one level up, `(..)(..)`
for two, and `(...)` for the app root. Route groups like `(dashboard)` do not
count as levels.

## When interception fires — and when it does not

The router intercepts **client-side navigations only**. Concretely:

| How you got there               | What renders                        |
| ------------------------------- | ----------------------------------- |
| `<Link>` click from the gallery | `@modal/(.)photos/[id]` — the modal |
| `router.push('/photos/x')`      | the modal                           |
| Reload (F5)                     | `photos/[id]` — the full page       |
| Paste the URL into a new tab    | the full page                       |
| A plain `<a href>`              | the full page                       |
| Server redirect                 | the full page                       |

This is why the gallery tiles are real `<Link>` elements with real `href`s
(`photo-grid.tsx`), and why "Open full page" inside the modal is a plain
`<a>` (`photo-detail.tsx`): from inside the modal the address bar already reads
`/photos/<id>`, so a soft navigation to it has nowhere to go and would leave
the modal exactly where it is. Only a document request falls through.

## Closing the modal is a navigation

`photo-modal.tsx` hard-codes `open` and maps every dismissal to
`router.back()`:

```tsx
<Dialog open onOpenChange={(open) => { if (!open) router.back(); }}>
```

Setting `open` to `false` instead would hide the overlay while leaving the
address bar on `/photos/<id>` — a URL whose content is no longer on screen,
and a subsequent Back press that appears to do nothing. There is no closed
state to model: when the URL is not a photo, the slot renders
`@modal/default.tsx`, which returns `null`.

`<DialogContent>` already turns Escape, the overlay click and the close button
into `onOpenChange(false)`, so all three become the same Back navigation.

## `default.tsx` is not optional

A parallel slot with no `default.tsx` throws at request time on any hard
navigation to a URL the slot does not match, because the router has no previous
state to fall back on. Adding `@modal` to the root layout without
`@modal/default.tsx` breaks a reload of _every page in the app_ while leaving
client-side navigation working — so it looks fine in development and fails in
production.

Returning `null` is the entire implementation, and it is what keeps `/`,
`/login`, `/register`, `/forbidden` and `/blog` prerendering exactly as they
did before the slot existed.

## Every failure mode here is silent

None of the following produce an error, a warning, or a failing type check.
The application compiles, the URLs work, and the only symptom is that clicking
a photo does a full page load instead of opening the modal:

- the marker is `(..)` instead of `(.)`
- `@modal` is nested under `photos/` instead of beside it
- `app/layout.tsx` stops rendering `{modal}`
- a tile becomes a `<button onClick={router.push}>`

`src/app/photos/interception.test.ts` asserts the file paths and the layout
wiring directly, for exactly that reason — the same reason
`scripts/assert-route-shape.ts` exists one level up.

## What is asserted where

| Claim                                                         | Where                                 |
| ------------------------------------------------------------- | ------------------------------------- |
| The interceptor and slot are at the paths the router requires | `src/app/photos/interception.test.ts` |
| Dismissal navigates rather than hiding                        | `photo-modal.test.tsx`                |
| Tiles are links carrying the photo's own URL                  | `photo-grid.test.tsx`                 |
| Modal and page render the same photo                          | `photo-detail.test.tsx`               |
| `/photos` is static, `/photos/[id]` is prebuilt               | `scripts/assert-route-shape.ts`       |
| A click opens a modal; a reload renders a page                | `e2e/photos.spec.ts`                  |

Only the last one can observe interception itself, and it needs a real
browser. See the note on E2E in the README — Playwright is not yet wired into
CI.

## Data

`src/lib/photos.ts` is a plain module, not a Prisma table. The feature being
demonstrated is routing, and a database read would pull `cacheComponents`
semantics, a seeded CI database and a `"use cache"` wrapper into it. Static
data also keeps both routes prerenderable, so `scripts/assert-route-shape.ts`
can hold them to `static` and `prebuilt` and a routing regression shows up as a
route-shape failure.

To add a photo: append one entry to `PHOTOS`. Both `generateStaticParams`
implementations read from `getPhotoIds()`, so the new photo is prebuilt on both
routes without any further change.
