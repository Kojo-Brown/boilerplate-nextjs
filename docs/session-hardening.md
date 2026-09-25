# Session hardening

A JWT session cookie is a bearer token with no server-side counterpart. It is
valid because it decrypts, and nothing else is consulted. That is what makes it
cheap — no query per request, no session table to shard — and it costs three
things:

- **It cannot be revoked.** Signing out clears the browser that asked. A copy
  made beforehand keeps working.
- **A theft cannot be noticed.** A replayed cookie is byte-identical to a
  legitimate one.
- **It does not end.** Auth.js refreshes the expiry on every read, so a cookie
  in active use never reaches one.

This document is how those are bought back, what each defence costs, and what is
still true after all of them.

## What shipped

|                     | Before                           | After                                |
| ------------------- | -------------------------------- | ------------------------------------ |
| Idle window         | 30 days, sliding                 | 24 hours, sliding                    |
| Absolute lifetime   | none                             | 7 days, fixed at sign-in             |
| Token rotation      | none                             | every 15 minutes of use              |
| Reuse detection     | none                             | replayed token revokes the session   |
| Revocation          | none                             | sign-out ends the session everywhere |
| Cookie name         | `__Secure-` (https)              | `__Host-` (https)                    |
| `Secure` decided by | `x-forwarded-proto`, per request | the pinned origin, once              |

The durations are in [`src/lib/auth/policy.ts`](../src/lib/auth/policy.ts), with
the argument for each value next to it.

## The defect underneath all of it

None of the above was observable before, because **sessions did not work in a
production build at all.**

Auth.js decides `trustHost` from `AUTH_URL ?? AUTH_TRUST_HOST ?? VERCEL ??
CF_PAGES ?? NODE_ENV !== "production"`. This repository uses the v4 name,
`NEXTAUTH_URL` — in `.env.example`, in `src/lib/env/server.ts`, in the CI workflow and
in the Dockerfile — and that name is not in the list. So a production build
anywhere but Vercel or Cloudflare Pages got `trustHost: false`, and
`assertConfig` refused every request into `@auth/core`.

Measured on unmodified `main`, with `pnpm build && pnpm start`:

```
GET  /api/auth/csrf                   -> 500  {"message":"There was a problem with the server configuration..."}
GET  /api/auth/session                -> 500
POST /api/auth/callback/credentials   -> 500   (never reaches the password check)
GET  /dashboard                       -> 302 /login
```

Nobody could sign in. Nobody who was signed in had a session, because
`next-auth` turns that 500 into `null` and every guard correctly fails closed.
The build exited 0, 1,882 unit tests passed and sixteen build gates were green,
because none of them start the server and sign in.

The fix is a pair, and only a pair:
[`src/lib/auth/deployment.ts`](../src/lib/auth/deployment.ts) copies the
validated `NEXTAUTH_URL` into `AUTH_URL` — which is the only variable
`createActionURL` reads — and `auth.config.ts` then sets `trustHost: true`.
Trusting the host is dangerous exactly when the host decides something; pinning
the origin is what stops it deciding anything. Rule R5 of the gate fails if
either half is ever removed without the other.

## Rotation

Every session is a **family**. `SessionFamily.id` is the `sid` claim and is
fixed for the life of the sign-in; `currentTokenId` is the `tid` claim and is
replaced every 15 minutes of use.

```
sign-in ───► tid=A  ──15m──►  tid=B  ──15m──►  tid=C
             current          current           current
                              prev=A            prev=B
                              (30s)             (30s)
```

Rotation turns a stolen cookie from a credential into a race. The thief's copy
stops working at the victim's next rotation, and the attempt to use it
afterwards is the signal in the next section.

**Rotation happens only in `src/proxy.ts`.** This is the single most
consequential line in the feature. Auth.js calls `callbacks.jwt` in three
situations and gives them all one signature, but only the proxy's response
carries the resulting `Set-Cookie` to the browser: `next-auth`'s React Server
Component path reads the session response's body and **drops its headers**,
because a Server Component cannot write a cookie. Rotating there would advance
the registry to a token the browser never receives, and the browser's next
request — carrying the token it still has — would be read as theft. So the
callback takes `mayRotate`, and rule R2 of the gate fails if anything but the
proxy passes `true`.

## Reuse detection

Presenting a `tid` that is neither current nor the one just replaced means two
parties hold cookies for this sign-in. There is no way to tell which is the
user, so **neither keeps it**: the family is revoked with `TOKEN_REUSE`, both
copies stop working, and the victim's next sign-in restores service.

Revoking only the presented token would be worse than useless — if the attacker
was the one who rotated, it would evict the victim and leave the attacker in.

### The grace window, and why it has to exist

A rotation is one `Set-Cookie` on one response. Every request already in flight
still carries the old token, and this application issues plenty at once:
parallel route slots, streamed Suspense boundaries, router prefetches. Without
an allowance, opening `/dashboard` would rotate on the document request and then
flag its own sub-requests as theft.

So the replaced token stays valid for 30 seconds (`SESSION_ROTATION_GRACE_S`) —
far longer than any of those take, far shorter than a replay is likely to be,
and well under the rotation interval so two windows can never overlap.

### Concurrent rotations

Two requests can read the same current token and both decide to rotate. The
write is therefore a compare-and-swap:

```sql
UPDATE session_families
   SET "currentTokenId" = $new, "previousTokenId" = $old, ...
 WHERE id = $sid AND "currentTokenId" = $old AND "revokedAt" IS NULL
```

Exactly one caller sees `count = 1`. The loser is _not_ an incident: it returns
the token unchanged, which is now the previous token inside its grace window, so
its request is served and the browser takes the winner's cookie. A read-then-
write would let both callers win, and the second would overwrite
`previousTokenId` — stranding a token the browser is already carrying and
turning ordinary concurrency into a revocation.

## The two bounds on a session's life

**Idle (24h)** is Auth.js's `session.maxAge`: the JWT's `exp` and the cookie's
`Expires`, refreshed on every request.

**Absolute (7d)** is the `sat` claim, fixed at sign-in and never extended. It is
checked _before_ the registry is read, deliberately — `sat` is inside the
encrypted token, so it needs no query and still holds if the database is
unreachable. The sliding window cannot express this bound, and without it the
answer to "when does this sign-in end?" is "when it stops being used", which for
a session somebody else is using is never.

## Cookie flags

```
__Host-authjs.session-token=…; Path=/; Expires=…; HttpOnly; Secure; SameSite=Lax
```

`__Host-` rather than Auth.js's `__Secure-`. Both require `Secure`; `__Host-`
also requires `Path=/` and **forbids a `Domain` attribute**, all enforced by the
browser at the moment the cookie is set. That last requirement is the one worth
having: without it, anything that can write cookies for a sibling host —
`staging.example.com`, a subdomain pointed at a third party, an XSS anywhere
under the registrable domain — can set a `Domain=.example.com` session cookie
that this application will read and accept. `__Secure-` does not prevent that.

The cost, stated rather than hidden: a deployment that needs one session across
`app.example.com` and `admin.example.com` cannot use this prefix, because that
needs the `Domain` attribute `__Host-` forbids. Such a deployment changes
`SESSION_COOKIE_NAME` back to a `__Secure-` name and adds `domain` — and gives
up this property knowingly.

`SameSite=Lax` and not `Strict`: `Strict` withholds the cookie on the cross-site
GET that ends an OAuth sign-in, so the callback would land without a session and
bounce to `/login`. `Lax` still withholds it from cross-site POSTs, which is the
CSRF-relevant half.

## The claim is `tid`, not `jti`

`@auth/core`'s `encode` ends:

```js
.setIssuedAt().setExpirationTime(now() + maxAge).setJti(crypto.randomUUID())
```

`iat`, `exp` **and `jti`** are overwritten after the `jwt` callback returns, with
no way to opt out. A token id stored under `jti` is discarded on its way into the
cookie and replaced with a value nothing recorded — so every request presents an
id the registry has never seen, reuse detection fires, and **signing in revokes
your session on the first page load**.

This is not a hypothetical. It is what the first draft of this feature did, and
the sign-in probe against a production build produced exactly three log lines:

```
{"event":"auth.session","type":"session_started","sid":"4908e211-…"}
{"event":"auth.session","type":"token_reuse","sid":"4908e211-…"}
{"event":"auth.session","type":"session_revoked","sid":"4908e211-…"}
```

with `GET /api/auth/session` answering `null`. A unit test that mocks the
encoder never encodes, so the whole suite would have passed either way. Rule R1
of the gate now fails on any claim name `jose` reserves, so the fix cannot be
undone by someone tidying an unfamiliar abbreviation into a standard one.

## What this costs

One indexed `SELECT` per session read, and one `UPDATE` per rotation interval
per active session. There is no write on the common path.

A page request reads the registry **twice**: once in the proxy, once in the
Server Component render (memoised for the rest of that render by
`getSession`'s `requestMemo`). They are separate processes as far as Next is
concerned and cannot share a result. The second read is what makes revocation
take effect inside a render rather than only at the next navigation, which is
the point of having it.

## What is still true

- **A cookie stolen and used inside 15 minutes works.** Rotation bounds the
  window; it does not close it. Reuse detection then ends the session the next
  time either party's token goes stale — which is detection, not prevention.
- **Reuse detection needs the two parties to interleave.** An attacker who
  steals a cookie and whose victim never returns rotates happily on their own
  until the absolute deadline. The defence fires when the victim comes back.
- **`MemorySessionRegistry` is for tests only.** It is per-process, and unlike
  the rate limiter's memory store — which degrades to a weaker limit — this one
  would _deny valid sessions_ on any instance that did not mint them.
- **Nothing here protects against XSS.** A script running on the page does not
  need the cookie; it can simply make requests. `HttpOnly` stops exfiltration,
  which is why the Content Security Policy in [csp.md](./csp.md) is the
  complementary control and not an optional extra.

## Revoking every session for a user

A password change owes this, and there is no password change in this application
yet — so it is written down here rather than shipped as a method with no caller:

```ts
await prisma.sessionFamily.updateMany({
  where: { userId, revokedAt: null },
  data: { revokedAt: new Date(), revokedReason: "REVOKED_BY_USER" },
});
```

Every one of that user's sessions stops on its next request, in the proxy, with
no cookie to reach and nothing to clear.

## Operating it

Security events are written to stdout as one JSON line each, under
`"event":"auth.session"`. `token_reuse` goes to `console.error` and everything
else to `console.warn`, because a session reaching its absolute deadline is the
policy working and paging on it would train people to ignore the channel that
also carries the incident.

`session_families` rows are kept after revocation on purpose: an operator
answering "why was I signed out?" needs to see `TOKEN_REUSE` rather than
`SIGNED_OUT`. `expiresAt` is the sweep key — a row past it can decide nothing
the `sat` claim would not already have decided.

## Where it lives

| File                                                                            | What it holds                                               |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [`src/lib/auth/claims.ts`](../src/lib/auth/claims.ts)                           | the four claims, and why the name is `tid`                  |
| [`src/lib/auth/policy.ts`](../src/lib/auth/policy.ts)                           | the durations and `classifyToken` — all pure                |
| [`src/lib/auth/registry.ts`](../src/lib/auth/registry.ts)                       | the store interface and the compare-and-swap                |
| [`src/lib/auth/harden.ts`](../src/lib/auth/harden.ts)                           | the `jwt` callback, parameterised over its clock            |
| [`src/lib/auth/deployment.ts`](../src/lib/auth/deployment.ts)                   | the pinned origin, `trustHost`, the cookie name             |
| [`src/auth.config.ts`](../src/auth.config.ts)                                   | the config both NextAuth instances share                    |
| [`src/proxy.ts`](../src/proxy.ts)                                               | the only caller that may rotate                             |
| [`scripts/assert-session-hardening.ts`](../scripts/assert-session-hardening.ts) | the six rules, each checked against the regression it names |
