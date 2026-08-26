# On-demand revalidation: prebuilt pages and the webhook that clears them

The blog is prerendered. `/blog/[slug]` enumerates its pages at build time with
`generateStaticParams`, and both blog reads refill on a timer set by `cacheLife`
in `src/lib/cache/blog.ts`. Everything inside this application that changes a
post already tells the cache so, through `invalidate()` in a Server Action.

This document covers the other half: how a change made **outside** the
application — a CMS, a migration, a bulk import, a restored backup — reaches the
cache, and the three decisions in `POST /api/revalidate` that are the actual
substance of it.

## What is prebuilt, and what happens to a post that is not

`generateStaticParams` returns one entry per published post:

```ts
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  const posts = await getPublishedPosts();
  return posts.map((post) => ({ slug: post.id }));
}
```

Three properties of that are worth stating, because two of them are the
opposite of what the route used to claim:

- **There is no `try`/`catch` fallback.** Returning `[]` when the database is
  unreachable is rejected outright by Cache Components
  (`EmptyGenerateStaticParamsError`), and before that it quietly prerendered
  nothing on every CI run, since CI built against an empty database. That is why
  the build job seeds before building, and why `scripts/assert-route-shape.ts`
  fails if `/blog/[slug]` produces no concrete pages.
- **There is no `dynamicParams` export.** It is not needed and Cache Components
  rejects it as segment config. On-demand generation of an unknown slug is the
  default for a dynamic segment, so a post published after the build is reachable
  immediately — it renders on the first request and is cached from then on.
- **A draft is never enumerated.** A preview reaches an unpublished post through
  that same on-demand path, holding a signed preview token; see
  [draft-mode.md](./draft-mode.md).

So a new post does not need the webhook to become _reachable_. It needs it to
become _visible in the list_, because `/blog` holds a cached array that does not
know a row appeared.

## The webhook

```
POST /api/revalidate
x-revalidate-signature: t=1774483200,v1=<hex>
content-type: application/json

{ "event": "post.published", "postId": "clx0ab12…" }
```

Answers `200` with the tags it dropped:

```json
{
  "revalidated": true,
  "tags": ["blog:post:clx0ab12…", "blog:posts"],
  "event": "post.published"
}
```

### Events

| Event              | Requires | Drops                                          |
| ------------------ | -------- | ---------------------------------------------- |
| `post.published`   | `postId` | that post + the list                           |
| `post.updated`     | `postId` | that post + the list                           |
| `post.unpublished` | `postId` | that post + the list                           |
| `post.deleted`     | `postId` | that post + the list                           |
| `blog.refresh`     | —        | the list (which every post entry also carries) |
| `ping`             | —        | nothing                                        |

`ping` exists because every CMS webhook UI has a "send test event" button, and
pointing it at a real event means the first thing an integrator does is purge
production's blog cache. An unrecognised event name is a `422` listing these
six, not a silent `200` — a CMS misconfigured to send `post.publish` would
otherwise report healthy deliveries forever while the blog stayed stale.

### Signing a request

The signature is `HMAC-SHA256(key, "<t>.<raw body>")` in lowercase hex, where
`t` is the unix second you signed at. `signWebhookPayload` in
`src/lib/webhooks/signature.ts` is the reference implementation, and the scheme
is Stripe's, so most CMS webhook senders can produce it as configured.

The key is `REVALIDATE_SECRET` if set, otherwise `NEXTAUTH_SECRET`, in both
cases put through HKDF-SHA256 with a domain separator specific to this feature.
Set `REVALIDATE_SECRET` when you want to hand a CMS a secret that can revalidate
and nothing else; leave it unset and no deployment has to configure a second
secret to use the endpoint. The separator is what keeps the derived key
unrelated to the session signer's and the preview signer's despite the shared
fallback — see `src/lib/crypto/hmac.ts`.

## The three decisions

### 1. The signature covers the raw bytes, not the parsed body

This is why the handler is not built on `defineRoute` like the rest of the API:
`defineRoute` parses the body for you, and a handler that receives a parsed
object has nothing left to verify against.

Verifying `JSON.stringify(parsedBody)` looks equivalent and is not. Key order,
unicode escaping, number formatting and whitespace all survive the sender's
serialiser and none survive a round trip through ours, so a re-serialising
verifier rejects valid requests from some senders — and, worse, is a verifier
whose input is not the thing that was signed.

### 2. The timestamp is inside the signed material

`t` sent as a plain field beside the signature would be an attacker-controlled
input to the freshness check: capture a valid delivery, rewrite `t` to now,
replay forever. Signing `"<t>.<body>"` means a rewritten `t` no longer verifies.

The five-minute tolerance window is applied symmetrically — a future-dated
signature is as suspect as a stale one, since accepting one unboundedly lets
anyone who compromises the secret once mint a request that stays valid
indefinitely.

**What the window does not buy is exactly-once delivery.** Inside it, the same
bytes can be replayed as often as an attacker likes. Closing that needs a store
of spent signatures shared by every instance, which this application does not
have and which a boilerplate should not invent — a `Map` in module scope is
per-instance, so it would work on one server and silently do nothing behind a
load balancer. For _this_ endpoint the hole is small: its entire authority is to
drop cache entries, and a replayed revalidation costs a cache fill. An endpoint
that wrote data would need the store.

### 3. `revalidateTag`, not `updateTag` — and it is a runtime difference

`src/lib/cache/invalidation.ts` now exports two entry points onto one policy:

| Caller        | Function                  | Next API                                             |
| ------------- | ------------------------- | ---------------------------------------------------- |
| Server Action | `invalidate()`            | `updateTag` (+ `refresh()` when nothing was dropped) |
| Route Handler | `revalidateFromWebhook()` | `revalidateTag(tag, { expire: 0 })`                  |

Not a stylistic split. `updateTag` throws `updateTag can only be called from
within a Server Action` (E872) — Next tests `workStore.page.endsWith('/route')`,
so it fires for every route handler — and `refresh()` throws the same way
(E870), because it signals the client that submitted an action to re-read its
uncached data, and a webhook has no such client.

**Both failures are invisible to a unit test**, because mocking `next/cache` is
precisely what stops them throwing. A webhook calling `invalidate()` typechecks,
passes its whole suite, and answers `500` to every real delivery. That is why
`e2e/revalidate-webhook.spec.ts` drives the endpoint against a production
server: it is the only place the claim is actually tested.

`{ expire: 0 }` rather than a named profile like `"max"`: the profile decides
what the dropped entry becomes, and `"max"` leaves the old copy servable while
it refills in the background. That would give this application two meanings for
"invalidated" — a person clicking Publish and a CMS publishing the same post
would reach readers at different times. Both expire immediately.

The one-argument `revalidateTag(tag)` is deprecated in Next 16.2.9 and warns on
stdout, which `pnpm run strict` turns into a failed build, so the argument is
not optional here in any sense.

## Why the wire vocabulary is not `CacheMutation`

`CacheMutation` carries _observations_: `post.updated` reports `wasPublished`
and `isPublished` because the Server Action reporting it had to read one and
write the other. An external sender cannot supply that. A CMS knows "this
document was published"; it does not know what our database thought a moment
ago, and inviting it to say would make the invalidation policy a function of a
remote system's opinion — including an attacker's, if the secret ever leaks.

So the wire vocabulary names transitions, and `mutationFor` in
`src/lib/webhooks/revalidate-events.ts` fills in the before/after pair each one
implies. That keeps `tagsFor` the single owner of "which tags does that drop":
a webhook that dropped tags of its own would be exactly the read/write drift
that `scripts/assert-cache-invalidation.ts` exists to prevent, arriving over
HTTP instead of through an import. The gate enforces the import half — only
`src/lib/cache/invalidation.ts` may call Next's invalidation APIs — and the
webhook obeys it.

`post.deleted` is mapped as `wasPublished: true` deliberately. A CMS deleting a
draft is indistinguishable from one deleting a live post, and only one of those
two mistakes leaves a dead page cached: over-invalidating costs a cache fill,
under-invalidating serves a deleted post for the remainder of its 300-second
window.

## What is deliberately not here

- **No existence check on `postId`.** Reading the post before revalidating would
  pull Prisma into the route's module graph — costing the `portable: true`
  declaration in `src/lib/api/runtimes.ts` — and would make the answer depend on
  replication lag between the CMS's write and ours. Dropping a tag nothing holds
  is free.
- **No rate limiting.** The endpoint is authenticated by signature, and a valid
  signature is already the scarce thing. A caller holding the secret can already
  purge whatever they like.
- **No per-path revalidation.** `revalidatePath` is not exposed. Tags are the
  interface, and they are defined in `src/lib/cache/tags.ts` on both sides — see
  [cache-invalidation.md](./cache-invalidation.md).

## Related

- [cache-invalidation.md](./cache-invalidation.md) — the tag policy and the gate
- [partial-prerendering.md](./partial-prerendering.md) — why `revalidate` moved
  off the route segment
- [draft-mode.md](./draft-mode.md) — the other signed capability, and the
  reasoning this signer's HKDF separation borrows
