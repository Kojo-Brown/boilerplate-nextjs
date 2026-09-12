# Bundle budgets and the per-route JS payload report

Every route in this application has a ceiling on the JavaScript it may ship to a
browser. `scripts/assert-bundle-budget.ts` measures what the build actually
wrote, compares each route against its budget, prints a per-route report, and
fails CI when a route goes over.

## Why this gate exists

Next 16 stopped printing the number.

The route table `next build` writes today has columns for `Revalidate` and
`Expire`. Under Turbopack there is no `First Load JS` column at all — the size
readout that used to make a bundle regression visible to anyone reading the
build log is simply gone. Nothing else in this repository looked at payload
size, so the remaining feedback loop for "this page got 80 kB heavier" was a
user on a slow connection.

That matters more in an App Router application than the missing column suggests,
because client JavaScript is not added by anyone deciding to add it. A Server
Component imports a helper; the helper imports a module carrying `"use client"`;
that module and its entire import graph are now in the browser bundle. No
directive changed. No import statement in the diff mentions a client component.
The build is green, every test passes, and the page renders correctly — it just
costs more to open.

This build has a live example. The providers chunk is 80 kB gzipped — TanStack
Query and Zod together — and it reaches every route except `/_global-error`,
which is the one route that replaces the root layout rather than nesting inside
it. That 80 kB is not a mistake; it is the price of the providers being global.
But it is a price nothing was reporting.

## Running it

```
pnpm build
pnpm exec tsx scripts/assert-bundle-budget.ts
```

It reads build output, so it needs a build first — running it against a stale
`.next` measures the stale build, and running it against no build at all says so
rather than reporting an empty application.

```
Route                     First load        Own      Budget    Headroom  Chunks
-------------------------------------------------------------------------------
/posts/[id]                 266.3 kB   118.9 kB    280.0 kB     13.7 kB      15
/posts                      262.5 kB   115.1 kB    276.0 kB     13.5 kB      13
...
/_global-error              147.6 kB     0.2 kB    156.0 kB      8.4 kB       8

Shared by every route: 147.4 kB across 7 chunk(s) (budget 155.0 kB) — React,
React DOM and the App Router runtime.
Legacy polyfill bundle: 39.5 kB, `noModule`, not counted above.
```

**First load** is every module script the route's document tells a browser to
fetch. **Own** is that minus the shared baseline — the part this route is
responsible for. In CI the same table is written to the job summary panel, where
a reviewer sees it without opening a log, and a machine-readable copy lands at
`.next/analyze/bundle-budget.json`, which rides along in the build artifact.

## What is measured, and what is deliberately not

**Measured from the prerendered documents, not from a manifest.** The gate walks
`.next/server/app/**/*.html` and reads the `<script src>` tags Next wrote. That
is the set a browser actually fetches on a cold visit to that URL. It is not the
set of chunks the application can ever load: chunks pulled in on navigation, or
behind a `dynamic()` boundary, are real code but nobody waits for them on first
paint, and summing the client build directory would measure the application
rather than any page of it.

**`noModule` scripts are excluded.** Next emits its legacy polyfill bundle —
39.5 kB gzipped here — with a `noModule` attribute, so every browser that
supports ES modules skips it. Counting it would add the same 39.5 kB to every
route and make the budgets describe a browser almost nobody uses. It is measured
and printed separately instead, and the gate fails if it ever appears as an
ordinary module script: losing that attribute is a 39.5 kB regression on every
route at once, and per-route budgets would show it as seventeen small
unexplained creeps rather than one cause.

**Gzip, not raw bytes.** Raw bytes are what a minifier reports; gzip is what
crosses the wire, and the two move independently — a change that adds repetitive
generated code can grow raw size by 30 kB and gzip by 2. Brotli would be closer
still for a CDN-served app, but gzip is in every Node the CI matrix runs and is
the conservative of the two. Compression is at level 9, which is what size
tooling conventionally reports.

**A route is budgeted against its worst page.** `/blog/[slug]` prerenders four
documents. They are one route with one budget, and the largest is the one a
visitor can be unlucky enough to land on.

**kB means 1000 bytes**, matching `next build` and the browser network panel
rather than binary kibibytes.

CSS is out of scope here; `scripts/assert-css-output.ts` owns the stylesheet.

## The two budgets

`SHARED_BASELINE_GZIP_BUDGET_BYTES` covers the chunks **every** route loads:
React, React DOM and the App Router runtime, 147.4 kB gzipped. It is budgeted
separately because it moves for entirely different reasons — a React upgrade, a
Next upgrade, a change to the root layout — and folding it into seventeen route
budgets would mean seventeen numbers moving at once with nothing recording that
they moved together.

`ROUTE_BUDGETS` is an explicit table: one entry per route that prerenders a
document, each with a ceiling and a sentence saying what that route carries.
The table is written down rather than derived from the build, for the same
reason `assert-route-shape.ts` writes its expectations down — a budget computed
from the build is not a budget, it is a description, and it would follow the
code wherever it drifted.

Every ceiling is the route's measured size rounded up to leave roughly 5% of
headroom. That is deliberate on both sides: tighter and the gate fails on
compressor noise between Node majors, looser and a route can absorb a whole
library before anyone hears about it.

The table is checked in both directions. A budgeted route that prerendered no
document fails — it either stopped prerendering, because a dynamic read moved
above it, or it was renamed and the entry is stale. A prerendered document that
matches no budget fails too, which is what stops a new route from shipping with
no ceiling at all.

## When the gate fails

```
/posts/[id]
  first-load JS is 429.6 kB gzipped, 149.6 kB over its 280.0 kB budget
  (measured on /posts/[id], 17 chunks, 282.2 kB of it this route's own).
```

Work out what arrived before deciding what to do about it:

1. `pnpm build && pnpm exec tsx scripts/assert-bundle-budget.ts` on your branch
   and on `main`, and compare the **Own** column. A jump on one route is a
   client-side import in that route's tree; a jump on every route at once is the
   root layout, the providers, or the framework.
2. Compare the chunk lists in `.next/analyze/bundle-budget.json` between the two
   builds to find which chunk is new or grew.
3. Then choose:
   - **The import should not be in the browser.** Move it behind a server
     boundary, or import the narrow module rather than a package index.
   - **It should be in the browser, but not on first load.** Pull it behind
     `next/dynamic` so it loads when the feature is used.
   - **It genuinely belongs there.** Raise the number in `ROUTE_BUDGETS` and say
     why in the PR. That is a one-line diff that shows up in review as what it
     is — a decision to ship more JavaScript.

What not to do is widen the budget to make CI green without reading which of the
three it was. The gate is not the cost; the bytes are.

## How this was verified

Adding a single `import { faker } from "@faker-js/faker"` to one client
component — `src/components/ui/theme-toggle.tsx`, which the nav renders on every
page — and rebuilding put 15 of the 17 routes over budget, between 141 kB and
151 kB each, and the gate exited 1 naming every one of them. `/_global-error`,
which does not render the nav, stayed exactly at the baseline. That is the
failure this gate is for: one import, in one file, in a component nobody would
think of as expensive.
