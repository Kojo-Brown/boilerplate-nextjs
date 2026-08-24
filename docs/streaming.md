# Streaming: where to put the boundary

Status: **done.** Every route under `(dashboard)/` puts its own markup in the
static shell and streams only what depends on the request.
`scripts/assert-streaming-boundaries.ts` fails CI if that stops being true.

This is the companion to [partial-prerendering.md](./partial-prerendering.md).
That document is about which routes prerender; this one is about _how much of a
route_ prerenders, which turns out to be a separate question with a separate way
of going wrong.

## The failure this fixes

`loading.tsx` is a Suspense boundary around a whole route segment. It is the
first thing anyone reaches for, it takes one file, and it is almost always too
high:

```tsx
// app/(dashboard)/posts/page.tsx — before
export default async function PostsPage() {
  const session = await getRequiredSession();
  const initialPosts = await getPostsByUser(session.user.id);

  return (
    <div>
      <h1>Posts</h1>
      {/* the count line and the list */}
    </div>
  );
}
```

`<h1>Posts</h1>` says the same thing to everyone. It cannot be prerendered
anyway, because the `await` above it means React has nothing to render until the
cookie has been read and the query has returned. The whole page is one hole, and
`loading.tsx` fills it with a grey rectangle where the heading goes.

Under Cache Components this is not just a paint-order problem. A request-scoped
read aborts the prerender at its boundary, so everything below the `await` is
**absent from the built HTML entirely**. Measured on this repository, before and
after:

| Route        | Prerendered document | Contains its own `<h1>` |
| ------------ | -------------------- | ----------------------- |
| `/dashboard` | 10,576 → 12,570 B    | no → **yes**            |
| `/posts`     | 7,808 → 6,178 B      | no → **yes**            |
| `/admin`     | 6,537 → 6,513 B      | no → **yes**            |
| `/images`    | 6,297 → 18,427 B     | no → **yes**            |
| `/upload`    | 5,795 → 7,846 B      | no → **yes**            |

Byte counts are the less interesting column, and two of them went _down_ —
the old documents were mostly skeleton markup, and the new fallbacks are smaller
than the whole-page ones they replaced. The column that matters is the second.
Five routes shipped a static document that contained the sidebar, a page-shaped
arrangement of grey boxes, and nothing the page itself renders.

`/images` is the clearest case: it is a demo gallery built from a module-level
array of literals, mentioning the visitor nowhere. One
`await getRequiredSession()` at the top — there purely as an access check — kept
all twelve kilobytes of it out of the shell.

## The rule

**A Suspense boundary belongs directly around the read, not around the page.**

Everything above the boundary is markup that is the same for every visitor, and
it prerenders. Everything below waits.

```tsx
// app/(dashboard)/posts/page.tsx — after
export default function PostsPage() {
  return (
    <PostsFrame
      section={
        <Suspense fallback={<PostsSectionFallback />}>
          <PostsSection />
        </Suspense>
      }
    />
  );
}
```

The page component is synchronous. That is the property to watch: an `async`
page is an awaited page, and an awaited page has its entire body behind the
await no matter how many `<Suspense>` elements are inside it.

Three corollaries, each of which came out of applying the rule here:

**One boundary per read, not per element.** `/posts` renders a count line and a
list, both from the same `getPostsByUser` call. Splitting them into two
boundaries would resolve them at the same instant and buy nothing but a second
set of streaming markers. `/dashboard`'s four session values are one boundary
for the same reason.

**The fallback is part of the layout, not a placeholder for it.** The card
chrome, the `<h2>`, and the four `<dt>` labels on `/dashboard` are page markup;
only the `<dd>` values come from the session. So the boundary sits inside the
`<dl>` and the fallback renders the _real labels_ with a skeleton where each
value goes. Nothing moves when the hole fills.

**A `fallback={null}` is worse than not streaming.** The page paints, then jumps
when the hole resolves. The CI gate rejects an empty fallback for this reason.

## `loading.tsx` after granular boundaries

It still matters — it is what a _client_ navigation paints while the RSC payload
streams, where the prerendered shell is not involved at all. But it should now
render the same thing the shell contains:

```tsx
// app/(dashboard)/posts/loading.tsx
export default function PostsLoading() {
  return <PostsFrame section={<PostsSectionFallback />} />;
}
```

Both files render one `*Frame` component and one `*Fallback`, so arriving by
link and arriving by URL look the same, and neither can drift when the heading
changes. `/posts` had drifted already: its `loading.tsx` drew six cards in a
three-column grid for a page that has always rendered a single vertical list, so
the layout rearranged itself in front of the reader on every navigation.

## Access checks and prerendering

A route cannot both gate on a cookie and prerender anything below the gate.
`/posts`, `/images` and `/upload` were "protected" by an
`await getRequiredSession()` at the top of the page component, which is
authorisation by rendering: the request reaches the application, the page
starts, the read redirects — and takes the page's whole body out of the shell on
the way.

The gate moved to `PROTECTED_PREFIXES` in `src/auth.config.ts`, where the proxy
turns an anonymous request away before a response has begun. That is earlier and
cheaper than what it replaced, and it does not remove the checks that sit next
to data:

- `<PostsSection>` still calls `getRequiredSession()` and scopes its query to
  that user id — the check that keeps one account's drafts out of another's.
- `getPresignedUploadUrlAction` still calls `auth()` before it signs anything. A
  Server Action is reachable whether or not anyone renders the page it is on, so
  this is the check that actually protects the bucket.
- `<AdminSessionFields>` still calls `getRequiredAdminSession()`.

What went away is a session read whose only job was to decide whether a route
may be rendered at all. `/images` and `/upload` render no user data, so there is
nothing left for a second check to stand next to; `src/app/(dashboard)/auth-guards.test.ts`
names all three routes and fails if one leaves `PROTECTED_PREFIXES`.

## What CI checks

`scripts/assert-streaming-boundaries.ts` runs after `pnpm build` and reads the
HTML the build wrote. For each route it asserts:

1. **The page's own markup is in the prerendered document.** Needles like
   `">Admin Panel</h1>"` — with the closing tag, because the sidebar links to
   most of these routes by name and a bare word would be satisfied by the
   navigation whatever the page rendered.
2. **Request-scoped reads are still outside it.** A minimum number of Suspense
   boundaries must still be pending when the prerender ends. A count that drops
   to zero means something that used to be per-request is now baked into a
   document served to everyone.
3. **No boundary prerendered an empty fallback.**

It is a minimum rather than an exact count on purpose. React finishes some
boundaries out of order even at build time — `/images` completes its whole body
into a trailing `<div hidden id="S:1">` with an inline `$RC("B:1","S:1")` after
it — and how a given run schedules that is not a property worth asserting. Those
trailing blocks _are_ part of the prerendered document: they ship in the same
response and are parsed before the document finishes loading. What is genuinely
dynamic never reaches the file at all, which is why matching against the whole
document is the right question and where in it the markup landed is not.

The gate was checked against the failure it names, not only against a passing
build: restoring `await getRequiredSession()` to `app/(dashboard)/images/page.tsx`
and rebuilding leaves `next build` green, leaves `assert-route-shape` green, and
fails this gate with the three missing needles.
