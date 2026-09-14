# Fonts

Two typefaces, downloaded at build time, served from this origin, and laid out
on a fallback matched to their metrics so that the swap when they arrive moves
nothing.

```
src/styles/fonts.ts   → Inter (--font-inter), JetBrains Mono (--font-jetbrains-mono)
app/layout.tsx        → <html className={fontVariables}>
src/styles/globals.css→ @theme: --font-sans, --font-mono  (+ the mono fallback face)
scripts/assert-font-loading.ts → fails the build if any of that stops being true
```

| Role          | Family         | Subset | Display | Fallback laid out as         |
| ------------- | -------------- | ------ | ------- | ---------------------------- |
| `--font-sans` | Inter          | latin  | `swap`  | Arial, adjusted (by Next)    |
| `--font-mono` | JetBrains Mono | latin  | `swap`  | Courier New, adjusted (here) |

## Why self-hosted

`next/font` fetches the font files during `next build` and emits them into
`.next/static/media`, so a visitor makes no request to `fonts.googleapis.com` or
`fonts.gstatic.com`. That removes two DNS lookups and two TLS handshakes to a
third party from the critical path, and removes them from the _render-blocking_
part of it: the Google Fonts embed is a stylesheet `<link>`, which blocks
rendering, to a host the browser has not yet connected to, with the font file a
second round trip behind it.

It also makes the page describable by a CSP that names no third party, which
Phase 11 needs.

The cost is that `next build` must be able to reach Google Fonts. CI restores
`.next/cache` between runs and `next/font` caches the downloaded files there, so
this is one fetch per font per cache miss, not one per build.

## Why the fallback face is the part that matters

A web font cannot be used for the first paint — it has not arrived yet. So the
first frame is laid out in a font the browser already has, and when the real one
lands every line is measured again. If the two fonts have different proportions,
every line changes width, some paragraphs change height, and everything below
them moves. That is Cumulative Layout Shift, and on a text-heavy page that has
been careful about images and ads it is the largest remaining source of it.

Four CSS descriptors fix this by making the stand-in lay out like the real font
before the real font exists:

| Descriptor          | What it pins                                    |
| ------------------- | ----------------------------------------------- |
| `size-adjust`       | Scales the donor so the average advance matches |
| `ascent-override`   | Height of the line box above the baseline       |
| `descent-override`  | Height below it                                 |
| `line-gap-override` | Leading                                         |

Together they mean the swap changes which glyphs are drawn and nothing about
where they sit.

The numbers are derived, not chosen:

```
size-adjust       = (font.xWidthAvg / font.unitsPerEm)
                  / (donor.xWidthAvg / donor.unitsPerEm)
ascent-override   = font.ascent  / (font.unitsPerEm * size-adjust)
descent-override  = font.descent / (font.unitsPerEm * size-adjust)
line-gap-override = font.lineGap / (font.unitsPerEm * size-adjust)
```

`next/dist/server/capsize-font-metrics.json` supplies the measurements, and it
is the same table `next/font` reads. `scripts/assert-font-loading.ts` recomputes
all four from it on every build, so the values written into `globals.css` cannot
drift away from the fonts they describe.

## Two things about `next/font` that are not what they look like

Both were found by building this application and reading the output, not from
the documentation, and both are why the gate exists.

**`fallback` removes the metric-matched face rather than adding to it.** Written
as

```ts
Inter({ subsets: ["latin"], fallback: ["system-ui", "arial", "sans-serif"] });
```

with `adjustFontFallback` left at its default of `true`, the build emitted _no_
adjusted `@font-face` at all and resolved the family to `"Inter", system-ui,
arial, sans-serif`. The option reads as "some extra fallbacks in case"; it acts
as the switch that decides whether the anti-CLS machinery is generated. Nothing
warns. The build is a second faster and the pages shift.

**`adjustFontFallback: false` does nothing here.** With no `fallback` and that
flag explicitly false, the adjusted faces were emitted anyway. The flag is
implemented in `next/dist/build/webpack/loaders/next-font-loader/postcss-next-font.js`
— the webpack loader — and Next 16 builds with Turbopack, which does not run it.

So neither option reliably reports what the build did. The only honest statement
about it is the emitted stylesheet, which is what the gate reads.

`src/styles/fonts.ts` therefore passes `fallback` to exactly one face, the
monospace one, and passes it deliberately — see below. The generic tail for the
sans face lives in `globals.css`, _after_ the adjusted face, where it cannot
displace it.

## Why the monospace face uses a different donor

`next/font` picks the donor by category: Times New Roman for a serif, Arial for
everything else — monospace included. For JetBrains Mono that is Arial scaled by
**134.59%** so that their _average_ advances agree.

Average is the wrong statistic for a monospace face. Arial's advances do not
agree with each other, so the fallback line has the right total width and the
wrong width at every point inside it. `/blog` and `/photos` set inline
`font-mono` spans inside flowing paragraphs; a span that measures differently
moves the wrap point of the paragraph around it, which moves every line after
it. The machinery meant to prevent shift causes it.

Courier New is monospace, is present on every desktop platform, and its advance
— 1229/2048 em against JetBrains Mono's 600/1000 — is the same 0.6 em to within
two hundredths of a percent:

| Donor       | `size-adjust` | Proportional? |
| ----------- | ------------- | ------------- |
| Arial       | 134.59%       | yes           |
| Courier New | 99.98%        | no            |

So `globals.css` declares `JetBrains Mono Metric Fallback` over Courier New, and
`fonts.ts` names it in `fallback` — which, per the section above, is also what
suppresses the Arial-donor face the build would otherwise generate. The gate
asserts the resolved order, so if a future Turbopack stops suppressing it and
puts the Arial face back in front, CI says so.

`local("Liberation Mono")` follows `local("Courier New")` in that face, and
Liberation Mono is a metric-compatible substitute for Courier New by design, so
the overrides stay exactly as correct on a Linux desktop as on the platform they
were computed for. Where neither is installed the face has no usable source, the
browser skips the family, and the stack falls through to `ui-monospace` — no
worse than not having written it.

## `swap`, not `optional`

`font-display: swap` shows the fallback immediately and swaps when the real font
arrives. `font-display: optional` gives the font ~100ms and then commits to the
fallback _for that page view_, which is the only setting that guarantees a CLS
of exactly zero.

`swap` is the right trade here because the fallback is metric-matched: the swap
does not move anything, so the shift `optional` would be avoiding is already
close to nothing. What `optional` would cost is real — a first-time visitor on a
slow connection sees Arial for the whole visit, and the typeface the application
was designed in becomes something only repeat visitors see.

`block` (and `auto`, which browsers treat as `block`) is the one wrong answer:
up to three seconds of invisible text to avoid a shift that is not happening.
The gate fails on anything but `swap`.

## Subsetting

`subsets: ["latin"]` does not decide which font files exist. All seven of
Inter's subsets are emitted and reachable through their `unicode-range`, so a
page that renders Greek still gets Greek, one round trip late.

What it decides is which subset is **preloaded**, and a preloaded file is paid
for on the critical path of every page whether its glyphs appear or not. For
this application — whose every string is English — that is one 48 kB file
instead of several times that.

Add a subset when the application is localised into a script that needs it.
Adding one is not free and the gate will say so: it fails on more than one
preloaded file per family, so the decision is made deliberately rather than by a
copied config.

`next/font` refuses to build without either `subsets` or `preload: false`, which
is the right default — the failure it prevents is silent.

## A known gap: no head preload

No prerendered document in this build carries a `<link rel="preload" as="font">`
in its `<head>`. The preload is emitted as a React resource hint inside the RSC
payload:

```
:HL["/_next/static/media/….woff2","font",{"crossOrigin":"","type":"font/woff2"}]
```

which the client acts on after the payload has streamed and been parsed, and
which reaches 15 of the 26 prerendered documents rather than all of them.

The font is still discovered early — the `@font-face` lives in the stylesheet
the `<head>` does link, and that link is render-blocking — but roughly a round
trip later than a head preload would manage. Closing it properly means getting
the hashed filename to the layout at build time, which is a build-time codegen
step and its own change.

So the gate asserts the weaker property that is actually true: the subset is
marked preloadable (`.p.` in the emitted filename) and something in the output
references it. A `preload: false` that left the file marked and hinted nowhere
still fails.

## What the gate checks

`scripts/assert-font-loading.ts`, run in CI after `pnpm build`:

1. No `fonts.googleapis.com` or `fonts.gstatic.com` anywhere in the stylesheets
   or the documents, and no `@font-face` fetching from an absolute URL.
2. `font-display: swap` on every face that fetches a file.
3. Each role's family list resolves to `<the font>, <an adjusted fallback>, …` —
   the second entry must be declared by an `@font-face` carrying all four
   overrides, so a generic keyword cannot sit in front of it.
4. Those four percentages still match what the capsize metrics compute for the
   donor the face itself names.
5. One preloaded subset per family, each under its byte budget, and no
   preloadable file belonging to no declared role.
6. Every preloaded file is referenced by at least one document.
7. Every prerendered document except `/_global-error` carries the generated
   class that defines the font variables on its `<html>` element.
8. Every file a face references exists in `static/media`.

Check 7 is the one whose failure looks most like success. Move
`className={fontVariables}` from `<html>` to `<body>` and every font is still
built, still preloaded and still declared — while `--font-sans` resolves to an
undefined variable and the whole application renders in `system-ui` behind a
stylesheet that looks correct.

## Changing a typeface

1. Edit the import and call in `src/styles/fonts.ts`.
2. If it is the monospace face, recompute the four overrides in `globals.css`.
   The gate prints the expected value in its failure message, so building once
   and reading the error is the intended workflow.
3. Update `FONT_ROLES` in `scripts/assert-font-loading.ts` — the family name and,
   if the file size moved, the budget.
4. `pnpm build && pnpm exec tsx scripts/assert-font-loading.ts`.
