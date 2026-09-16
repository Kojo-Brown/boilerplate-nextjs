# Third-party scripts

Every origin a visitor's browser is asked to contact that this application does
not serve is declared in one file, loads on the terms recorded there, and is
checked by a gate on every build.

```
src/lib/third-party/catalogue.ts      the inventory: what, how, why
  ├── src/components/third-party/third-party-scripts.tsx   mounts <Script> + hints
  └── src/components/third-party/video-facade.tsx          mounts nothing until pressed
scripts/assert-third-party-scripts.ts the audit — 8 rules, runs in CI
```

## Why a declaration and not a measurement

The other gates in this repository measure what the build produced.
`assert-bundle-budget.ts` reads the documents Next wrote and the chunks each one
loads; `assert-route-shape.ts` reads the prerender manifest. Both are the right
instrument for first-party code and both are blind to third-party code by
construction:

- A vendor's script is not in a chunk, not in the route manifest, and adds
  nothing to any route's first-load JavaScript. A page that spends two seconds
  of main thread inside someone else's analytics passes every check here.
- What that script loads is decided **after the build**, by someone outside this
  repository, and can change without a commit. A tag manager is four lines in
  the diff and an open-ended grant of execution in production.

So the control is a declaration. Adding an origin is a thing someone writes
down, and the audit is what stops the written-down version and the code from
drifting apart.

## The catalogue

Each entry records three decisions, and each of them is enforced:

| Field        | What it decides                                                |
| ------------ | -------------------------------------------------------------- |
| `loading`    | `script` (with a `next/script` strategy), `facade`, or `asset` |
| `preconnect` | whether every document opens a connection to it up front       |
| `mountedBy`  | the one module allowed to load it                              |

`why` is the field no code reads and the one a reviewer does. An inventory whose
entries have stopped explaining themselves is a list of hostnames.

Today's entries:

| id                | Loading                    | Preconnect | Notes                               |
| ----------------- | -------------------------- | ---------- | ----------------------------------- |
| `plausible`       | script, `afterInteractive` | yes¹       | inert unless a domain is configured |
| `youtube`         | facade                     | no         | ~1.2 MB, loaded on the press        |
| `unsplash-images` | asset                      | yes        | the LCP element on `/photos`        |
| `google-avatars`  | asset                      | no²        | signed-in users only                |

¹ Only when `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` is set. An unconfigured deployment
warms nothing and loads nothing.
² The host is a wildcard (`**.googleusercontent.com`) and `rel="preconnect"`
takes one origin, so there is nothing to name.

## Choosing a strategy

`next/script`'s `strategy` is the property that decides what a third-party
script costs, and its default — `afterInteractive` — applies when the prop is
simply missing. That is why the audit fails on an omitted `strategy` rather than
letting the default stand: a default is not a decision, and a diff that adds a
`<Script src=…>` with no strategy shows nothing to argue with.

| Strategy            | Runs                           | Use it when                                                                                                                                       |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beforeInteractive` | before any hydration           | consent managers and bot detection — things that must run before the page is usable. **Root layout only**; Next silently demotes it anywhere else |
| `afterInteractive`  | immediately after hydration    | analytics and anything whose data would be biased by waiting                                                                                      |
| `lazyOnload`        | after the window `load` event  | chat widgets, support tools, anything nobody needs in the first seconds                                                                           |
| `worker`            | in a web worker (experimental) | rarely; requires Partytown and does not fit every script                                                                                          |

The one that looks like a free win and is not is `lazyOnload` for analytics. It
waits for `load`, so a visitor who bounces first is never counted — and the
pages that lose visitors early are the slow ones, which biases the metric in
exactly the direction that hides the problem.

## The facade pattern

A facade is markup this application serves standing in for a third party until
someone asks for it. `VideoFacade` is the worked example:

- Before activation, a poster frame and a play button. No iframe, no preload,
  no connection. `video-facade.test.tsx` asserts the rendered markup does not
  mention the embed origin at all, and `e2e/third-party.spec.ts` asserts the
  browser makes no request to it.
- On activation, the `<iframe>` mounts with `autoplay=1` — the press is the user
  gesture the browser's autoplay policy needs, so the viewer does not have to
  press a second time inside the frame. A facade that makes you click twice is
  the tell that the pattern was copied without being used.
- The connection is warmed on **hover and focus**, not on render, using React
  19's `preconnect` from `react-dom`. Hover precedes the click by roughly what a
  DNS lookup and a TLS handshake cost, and React deduplicates the hint, so no
  guard flag is needed.

Three things are easy to get wrong:

1. **Preconnecting the facade's origin.** It looks like an optimisation and it
   undoes most of the pattern: every reader pays a handshake for a player almost
   none of them will open. Rule R8 fails the build on it.
2. **Taking the poster from the vendor's thumbnail CDN.** `i.ytimg.com` is the
   obvious source and it puts a request back on every article's first paint.
   Serve the poster from an origin the page already uses — `/blog/[slug]` takes
   it from the photo catalogue.
3. **Loading on scroll instead of on press.** An `IntersectionObserver` that
   mounts the embed when it nears the viewport turns a facade into a slower
   embed rather than an absent one. "The visitor scrolled past it" is not
   evidence that the visitor wants it.

The `allow` attribute deserves its own line. It is a Permissions Policy
delegation, so every capability listed there is granted to the third party for
the lifetime of the frame. The snippet YouTube hands you includes
`clipboard-write` and `web-share`, neither of which a player needs to play a
video; the facade grants `accelerometer; autoplay; encrypted-media; gyroscope;
picture-in-picture` and nothing else.

## What the audit checks

`pnpm exec tsx scripts/assert-third-party-scripts.ts`, run in the CI build job.

| Rule | Fails when                                                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | a hand-written `<script>` is in the React tree, or a script is injected through `dangerouslySetInnerHTML`. JSON-LD is exempt — it is data, never executed |
| R2   | a `<Script>` is rendered without an explicit `strategy`                                                                                                   |
| R3   | `strategy="beforeInteractive"` appears outside the root layout, where Next silently demotes it                                                            |
| R4   | an absolute URL in a subresource attribute (`src`, `href` on `<link>`, `data` on `<object>`) resolves to a host the catalogue does not declare            |
| R5   | `next.config.ts`'s `images.remotePatterns` and the catalogue's asset entries disagree, in either direction                                                |
| R6   | a `script` or `facade` entry names a mount that does not exist, or a mount that does not import the entry's id constant from the catalogue                |
| R7   | any module other than a declared mount imports `next/script`                                                                                              |
| R8   | a facade's origin, or a wildcard host, is marked `preconnect: true`                                                                                       |

R4 reads literals only. A URL built at runtime is unreadable to a static gate,
and treating an unreadable value as satisfying a rule is how a check passes on
code it never understood — so a computed `src` is skipped, and the catalogue
plus R7's containment are what cover it.

What the audit deliberately does **not** check is behaviour. That a facade
renders no iframe before it is pressed is a property of a running component, and
it is asserted where it can actually be observed: in the component's own tests
and in `e2e/third-party.spec.ts`, which watches the network.

## Adding a third party

1. Add an entry to `THIRD_PARTIES` in `src/lib/third-party/catalogue.ts`, with
   an exported id constant, and write `why` for a reviewer rather than for a
   linter.
2. Decide `loading`. If it is a widget a minority of visitors will interact
   with, it is a facade.
3. Decide `preconnect`. Yes only if every page view is going to contact it.
4. Mount it from the module named in `mountedBy`, importing the id constant and
   taking the `src` and `strategy` from the entry.
5. For an image host, add the pattern to `images.remotePatterns` in
   `next.config.ts` as well — R5 checks both sides.
6. Run `pnpm exec tsx scripts/assert-third-party-scripts.ts`.

## Configuration

| Variable                       | Effect                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` | unset or blank: no analytics script is mounted and no request is made. Set to the bare domain (`app.example.com`, not a URL) to load it |

`NEXT_PUBLIC_` means the value is inlined into the client bundle and is public by
construction. That is correct for a site identifier and would not be for a key —
Plausible's ingest needs no key, which is part of why it is the entry in the
catalogue.

## See also

- [docs/web-vitals.md](./web-vitals.md) — the field data that shows what a
  third-party script actually cost.
- [docs/bundle-budget.md](./bundle-budget.md) — the per-route budget, and why it
  cannot see any of this.
