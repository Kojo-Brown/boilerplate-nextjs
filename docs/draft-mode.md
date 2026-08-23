# Draft mode and signed preview tokens

How an author (or an external CMS) opens a session that renders unpublished
content, why the destination is inside the signature, why this does not cost
`/blog` its static prerender, and what the preview session's real lifetime is.

## The flow

```
 dashboard                    /api/preview                    /blog/<id>
     │                             │                              │
     │ createPreviewLinkAction     │                              │
     │  · requires a session       │                              │
     │  · requires post ownership  │                              │
     │  · signs { path, exp, nonce }                              │
     ├────────── URL with ?token ─▶│                              │
                                   │ verify signature             │
                                   │ verify not expired           │
                                   │ draftMode().enable()         │
                                   ├──── 307 to payload.path ────▶│
                                                                  │
                                              getBlogPost() sees draft mode,
                                              reads uncached, returns drafts,
                                              PreviewBanner renders
```

Exiting is a plain `<form>` in the banner posting to `exitPreviewAction`, which
calls `draftMode().disable()` and redirects. `DELETE /api/preview` does the same
thing for a CMS that has a session to end and no page to return to.

| Piece                               | File                           |
| ----------------------------------- | ------------------------------ |
| Token format, signing, verification | `src/lib/preview/token.ts`     |
| Reading the flag                    | `src/lib/preview/draft.ts`     |
| Redeeming a token                   | `src/app/api/preview/route.ts` |
| Minting a link / leaving            | `src/actions/preview.ts`       |
| Choosing the cached or draft read   | `src/lib/cache/blog.ts`        |
| Banner and draft label              | `src/components/preview/`      |

## Why the path is signed, not passed

Next's own draft-mode guide takes the destination from the query string:

```ts
const slug = searchParams.get("slug");
// …
redirect(`/posts/${slug}`);
```

The secret there authorises _entering draft mode_; the destination is whatever
the caller appended. Two consequences follow, and neither is obvious from
reading the snippet:

1. Any preview link is an **open redirect** for the whole origin. Append
   `?slug=//evil.example` and the endpoint sends the browser there — with the
   application's own domain in the address bar until it lands.
2. Every link is **interchangeable**. A link minted for one post previews any
   other, because the token says nothing about which one it was for.

Here the path is part of the signed payload, so the destination is an _output_
of verification rather than an input to it. `isSafePreviewPath` is applied on
both sides anyway — when minting and again when redeeming — because "signed by
us" and "safe to send a browser to" are different claims.

## Why this does not break Partial Prerendering

`/blog` is prerendered static with a 60-second window, `/blog/[slug]` is
prebuilt from `generateStaticParams`, and `scripts/assert-route-shape.ts` fails
CI if either stops being true. Every request-scoped read in Next — `cookies()`,
`headers()`, `searchParams` — is _tracked_ as a dynamic access and would push
those routes out of the prerender the moment it appeared in a page body.

Reading `draftMode().isEnabled` is not tracked. In Next 16.2.9 the tracking sits
on `enable()` and `disable()`, the mutations, and not on the getter
(`next/dist/server/request/draft-mode.js`). During a prerender the work unit
store is of type `prerender`, `draftMode()` resolves to a null provider, and
`isEnabled` is a plain `false` — so the shell builds with the published branch
baked in, exactly as before.

At request time, a cookie changes everything downstream of it:

- `workStore.isDraftMode` is set, which makes `isStaticGeneration` false.
- `shouldForceRevalidate()` returns true for every `"use cache"` entry in the
  request, so cached reads re-execute.
- Cache entries produced during the request are **not saved**
  (`use-cache-wrapper.js` guards the write on `!workStore.isDraftMode`).
- The response carries `Cache-Control: private, no-cache, no-store`.

Verified against a production build rather than taken from the docs: two draft
requests to `/blog` two seconds apart returned render stamps two seconds apart,
while two public requests returned the same stamp.

`src/lib/cache/blog.ts` still branches _outside_ its `"use cache"` functions.
Not because the framework would cache a draft — it demonstrably will not — but
because "a draft response can never become a cache entry" should be a property
of the shape of the code rather than of a framework internal.

## The leak this nearly shipped

Worth writing down, because every unit test passed while it was live.

`app/blog/[slug]/page.tsx` used to hold the published check itself:

```ts
if (!post || !post.published) notFound();
```

Draft mode needs an unpublished post to render, so the guard was relaxed to
`if (!post)`. That is correct **only if the read applies the filter** — and
`getCachedPost` called `getPostById`, which does not. For one commit, a public
unauthenticated request to an unpublished post's URL answered 200 with its title
and full body.

Nothing in the unit suite noticed: every test that touched the page mocked the
read, and every test that touched the read asserted only its cache tags.
`e2e/preview.spec.ts` caught it, on the assertion that a second browser context
with no cookies cannot see the draft.

The fix moved the filter into the query — `getPublishedPostById` uses
`where: { id, published: true }` — so the cached entry the whole public shares
cannot contain a draft at all, whatever a component does with it later.

> **A related wart, not fixed here.** Under Partial Prerendering `/blog/[slug]`
> answers **200** even for a slug that never existed: the static shell is
> flushed before the dynamic hole reaches `notFound()`, so the status is already
> on the wire. This predates draft mode (`/blog/anything-at-all` returns 200 on
> `main`) and is why the e2e test asserts on content rather than status.

## The signing key

`PREVIEW_SECRET` is optional. When it is absent the signer derives its key from
`NEXTAUTH_SECRET` with HKDF-SHA256 and a fixed `info` string, so:

- no deployment has to set a second secret to use draft mode, and nobody is
  tempted to commit a placeholder for one;
- the preview signer and the session signer never hold the same bytes, despite
  descending from one secret;
- rotating `NEXTAUTH_SECRET` invalidates outstanding preview links, which is the
  behaviour you would want anyway.

Set `PREVIEW_SECRET` (32+ characters) when preview links should survive an
auth-secret rotation, or when the preview signer is to be handed to a CMS
without handing over the session signer.

The key is derived once per process into a non-extractable `CryptoKey`. Nothing
in `src/lib/preview/token.ts` is importable from a client component: it reads
`@/lib/env`, whose server-only variables are undefined in the browser, so such
an import fails loudly at module evaluation rather than shipping a secret.

## What `exp` bounds, and what it does not

`exp` bounds the **link**: fifteen minutes by default
(`PREVIEW_TOKEN_TTL_SECONDS`), which is a click-through window rather than a
working session. The realistic leak for a preview URL is being forwarded in an
email or pasted into a ticket, and an expiry is the difference between a stale
link and a permanent one.

It does **not** bound the session the link opens. Draft mode is Next's
`__prerender_bypass` cookie, and its value is compared against a `previewModeId`
minted at build time. So a preview session ends when:

- the reader clicks **Exit preview** (or a CMS calls `DELETE /api/preview`);
- the browser session ends — the cookie has no `Max-Age`;
- **the application is redeployed**, because the new build mints a new
  `previewModeId` and every outstanding cookie stops matching.

An expired token cannot retroactively close a session that is already open.
Scoping a live session to the token's path would require reading a second cookie
on every render, and `cookies()` _is_ a tracked dynamic read — it would cost
`/blog` its static prerender. That trade was not worth making: the banner is
always visible while a session is open, and the session grants no more than a
signed-in author already has.

## Adding another previewable route

1. Read the flag through `isPreviewEnabled()` from `@/lib/preview/draft` —
   never `draftMode()` directly, so the "not a tracked read" reasoning stays in
   one place.
2. Branch **outside** any `"use cache"` function, as `getBlogIndex` does.
3. Render `<PreviewBanner returnTo="/your/path" />`. Pass the path explicitly:
   reading the current one on the server is a tracked dynamic access.
4. Label unpublished content with `<DraftBadge />`. The banner says the session
   is a preview; the badge says which part is not live.
5. Mint links through a Server Action that checks the caller may see the
   content. `/api/preview` verifies a signature and nothing about who holds it —
   authorisation happens once, at minting, and nowhere else.
