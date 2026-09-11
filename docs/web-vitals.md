# Core Web Vitals

The application measures its own field performance and ships it somewhere you
can query. No configuration is required to get data — an unconfigured checkout
writes one JSON line per metric to stdout, which every platform this boilerplate
targets already collects.

```
useReportWebVitals → queue (batch, dedupe, attribute)
                   → beacon → POST /api/vitals → sink (log | http)
```

## Why field data, not Lighthouse

Lighthouse measures one load, on one machine, on a synthetic network profile.
Core Web Vitals are a distribution over real visitors, and the two disagree in
exactly the cases that matter: a p75 LCP is dominated by cold caches, slow
devices and bad connections, none of which a local audit has. The number Google
ranks on, and the number a user experiences, is this one.

Three metrics make up the set today:

| Metric | What it measures                           | Good   | Poor   |
| ------ | ------------------------------------------ | ------ | ------ |
| LCP    | When the main content finished rendering   | ≤2.5 s | >4 s   |
| INP    | Worst interaction latency across the visit | ≤200ms | >500ms |
| CLS    | How much the layout moved after paint      | ≤0.1   | >0.25  |

FCP and TTFB are collected too — they are diagnostics for LCP rather than
ranking factors — as is FID, which the web no longer reports for new page loads
but old browsers still send. So does Next's own `Next.js-hydration` and friends,
which answer "is this the framework or the network?". Those three are rated
`unrated`: they have no published thresholds and must not be charted beside the
Core Web Vitals as though they did.

The thresholds live in `THRESHOLDS` in `src/lib/vitals/metric.ts`, copied from
web.dev rather than read off the metric's own `rating` field. The browser's
rating is computed by whichever version of `web-vitals` Next happens to bundle,
so taking it would let a framework upgrade move the line between "good" and
"poor" underneath a dashboard that spans both sides of it.

## The client

`<WebVitalsReporter>` is mounted in `src/app/layout.tsx` and can only be mounted
there. `useReportWebVitals` has to be subscribed before the measurements it
waits for are produced, and LCP and TTFB are produced during the first paint —
so a reporter mounted inside a route group misses the landing page on every
visit while reporting normally for every other page. That is worse than
collecting nothing, because the data looks healthy.

It renders `null`, reads nothing per-request, and is the only client component
the root layout has. None of the static routes changed shape when it was added;
`scripts/assert-route-shape.ts` is what holds that.

### Why the path comes from `location`, not `usePathname`

`usePathname` is the obvious choice and it is the wrong one here, for the reason
the root layout's docblock gives about `auth()`: it is a per-request read, and a
per-request read in the root layout is inherited by every route beneath it.
Under Cache Components the build says so outright, naming this component:

```
Error: Route "/posts/[id]": Uncached data was accessed outside of <Suspense>.
    at <unknown> (src/components/vitals/web-vitals-reporter.tsx)
```

Wrapping the reporter in a `<Suspense>` boundary would silence that while still
putting a dynamic hole in all fourteen routes — to obtain a string the component
never renders and only ever reads inside a callback that runs after hydration.
`location.pathname` is the same string with no server read at all.

It is read when the measurement **arrives**, not when the batch is flushed. The
flush happens as the page goes away, which in an SPA is frequently after a
client-side navigation has already changed the URL, so reading it then would
file the landing page's LCP under wherever the visitor went next.

### Why it buffers

`useReportWebVitals` fires once per measurement, and several measurements are
revised as the page lives: CLS grows with every layout shift, INP is re-reported
whenever a slower interaction displaces the previous one. Posting on each call
would mean eight or more requests per page view whose early entries are
superseded before the visitor has finished reading.

`createVitalsQueue` buffers instead, and does three things that a plain array
would not:

- **A revision replaces its predecessor.** `web-vitals` mints one id per metric
  per page load and reuses it across re-reports, so the id is the identity and
  the last report under it wins.
- **A navigation is a boundary.** This is an SPA, so a route change does not
  reload the page and the same reporter keeps feeding the same queue with
  metrics belonging to a different URL. `add` flushes the outstanding batch
  before accepting a metric for a new path — otherwise the landing page's LCP is
  filed under wherever the visitor went next.
- **It never sends an empty batch.** Every flush listener fires on pages that
  produced nothing.

### Why the flush is on `visibilitychange` and `pagehide`

There is no event that reliably fires when a page closes. `unload` and
`beforeunload` are not dispatched at all on mobile Safari — a backgrounded tab
is frozen and discarded — and, worse, registering a listener for either
disqualifies the page from the back/forward cache. Adding one therefore fails to
collect the metric _and_ makes the visitor's next navigation slower, in the
metric this feature exists to measure. `scripts/assert-vitals-wiring.ts` fails
the build on their presence.

`visibilitychange` to `hidden` is the last callback a page is guaranteed to get;
`pagehide` covers a tab hidden and torn down in one step. Both are wired, and
the queue is empty after the first fires, so the second is a no-op.

The send itself is `navigator.sendBeacon`, which is the only transport the
specification requires the user agent to complete after the document is gone. A
`fetch` with `keepalive: true` is the fallback, for a browser without it and for
a payload the user agent declines to queue. Both failures are swallowed:
nothing a visitor can see depends on a metric arriving.

## The endpoint

`POST /api/vitals` is unauthenticated, and has to be — the measurements worth
having are from a signed-out visitor's first paint, so requiring a session would
collect data from exactly the population whose experience is already good.

That makes the body attacker-controlled in the ordinary case rather than the
exotic one, which is why:

- Every field is bounded by `vitalsPayloadSchema`: a closed list of metric
  names, a ceiling on `value` (one posted `1e308` moves every mean computed
  over this data), a maximum batch size.
- The schema is `.strict()`. `web-vitals` attaches an `entries` array of raw
  `PerformanceEntry` objects, and an LCP entry names the element it measured —
  including, for a text node, its content. Rejecting unknown keys makes
  forwarding a new field a decision someone makes on purpose.
- `path` is the pathname only, never `location.href`, and is pattern-checked to
  contain no query or fragment. A query string on a real page is where the
  search term, the share token and the OAuth `code` live, and this endpoint
  writes what it is given straight into a log drain.
- The **rating is computed on the server**. A client-supplied rating is a
  client-supplied claim about its own performance.

The budget in front of it is `TELEMETRY_POLICY` — 240/minute per client, rather
than `api-write`'s per-endpoint 60, because beacon traffic scales with
readership and an office behind one NAT gateway can produce a hundred a minute
doing nothing unusual. It is not exempted, because with a collector configured
one cheap unauthenticated POST becomes one outbound request, which is an
amplifier. Refusal is free here in a way it is nowhere else in that table: a 429
on a beacon costs a metric nobody was waiting for.

### 202, and 202 even when the sink is down

The response is `202 Accepted` because that is what happened — and
`navigator.sendBeacon` discards the response entirely, so there is no client to
inform of anything else.

A sink failure therefore does **not** become a 5xx. This endpoint is hit once
per page view, so a collector outage handled the obvious way would put the
application's own error rate through the roof and page whoever is on call, for
telemetry. The failure is logged under a `[vitals]` marker an alert can select
on instead: visible to the people who care about metrics, invisible to the
availability numbers.

## Sinks

```ts
export interface VitalsSink {
  name: string;
  deliver: (events: readonly VitalsEvent[]) => Promise<void> | void;
}
```

`resolveVitalsSink()` picks one from the environment per request.

### `log` — the default

Unset `VITALS_COLLECTOR_URL` selects it. One JSON line per metric on stdout:

```json
{
  "event": "web-vitals",
  "path": "/blog/hello-world",
  "metric": {
    "id": "v5-1737000000000-1234567890123",
    "name": "LCP",
    "value": 1834,
    "delta": 1834,
    "navigationType": "navigate",
    "rating": "good"
  },
  "receivedAt": "2026-09-11T09:41:02.774Z"
}
```

Unset is the supported default, not a disabled state. A default that required an
API key would mean this feature ships in the condition it is already in — off,
and never observed working. Every platform here targets collects stdout and
every log platform that does can parse a JSON line, so this is queryable on
Vercel, on CloudWatch, on Loki and in `docker logs`, on the first deploy.

One line per metric rather than one per batch because a batch is a transport
artefact: it exists because beacons are expensive, not because the metrics in it
belong together. Every query anyone writes groups by metric name and path ("p75
LCP on `/blog` this week"), and a row per metric makes that a filter rather than
a JSON traversal inside the query.

```
# p75 LCP by path, over a week of lines
jq -c 'select(.event=="web-vitals" and .metric.name=="LCP")' app.log
```

### `http` — forward to a collector

```bash
VITALS_COLLECTOR_URL=https://collector.example/ingest
VITALS_API_KEY=...            # optional; sent as Authorization: Bearer …
```

The batch goes as one request with an array body, which is the shape every
ingest API in this space accepts and keeps the forward at one request per beacon
rather than one per metric. It is bounded by `AbortSignal.timeout` — a collector
that accepts connections and then stalls would otherwise hold a server task open
per page view until the platform killed it, which is how a telemetry outage
becomes an application outage.

A non-2xx response throws, and so does a timeout. The sink must not report a
delivery it did not make: that rejection is the only way anyone learns the
collector has been rejecting everything for a week.

### Writing your own

Implement `VitalsSink` and return it from `resolveVitalsSink`. The seam is
deliberately at that function rather than in the route handler, so a vendor SDK
never appears in the endpoint's module graph — `/api/vitals` is declared
`portable` in `src/lib/api/runtimes.ts`, and `scripts/assert-api-runtimes.ts`
fails the build if it stops being.

## What this does not do

Named here rather than discovered later:

- **No sampling.** Every measurement is sent. At the volumes a boilerplate
  starts at that is the right default, and a `Math.random()` gate is the wrong
  one — sampling has to be per-visitor and sticky, or the p75 is computed over a
  population that changes shape between metrics. Add it in the queue, keyed on a
  value stable for the session.
- **No attribution.** `web-vitals/attribution` names the element responsible for
  an LCP or a layout shift, which is what turns "CLS is 0.3" into a fix. It is a
  different import and a larger payload with a real privacy surface (element
  selectors and text content), so it is a deliberate opt-in rather than
  something this ships by default.
- **No user or session identity.** Nothing on the wire identifies who produced a
  measurement, and the `.strict()` schema rejects an attempt to add one without
  a matching change on the server. Attaching a user id would make this endpoint
  a per-visitor tracking beacon.
- **No storage.** The sink forwards; it does not retain. Aggregation, retention
  and p75s belong in the collector, which is also where they can be computed
  over more than one instance's memory.

## Gate

`scripts/assert-vitals-wiring.ts`, in the `build` job. It fails if the reporter
is not rendered in the root layout, has stopped calling `useReportWebVitals`,
has lost its `"use client"` prologue, is missing a required flush listener or
has gained a forbidden one, or if `VITALS_ENDPOINT` no longer names a route
handler that exports `POST`, is declared in `API_ROUTES`, and matches a rate
limit rule.

Every one of those is a change that builds, type checks, renders correctly and
passes every other check in this repository. The gate exists because the
alternative is finding out when someone needs the numbers.
