# Server Actions

Every export of a `"use server"` module is an unauthenticated `POST` endpoint.

Not the ones wired to a `<form>`. Not the ones a client component imports. All
of them — including a helper that was only ever meant to be called by another
action, which Next compiles into an entry in the server reference manifest and
serves to anyone who can guess or scrape its id. There is no `export` visibility
in that manifest and no "internal" modifier.

This repository has paid for that once already. `src/actions/blog.ts` used to
export:

```ts
// Ids need no allowlist here: this is called by the post mutations, not from
// the browser.
export async function revalidatePost(id: string) { … }
```

Both halves of that comment were wrong. It was reachable from the browser with
any id, and no post mutation ever imported it.

## The three legs

A Server Action call is safe when three things are true, and they are the three
this repository enforces structurally rather than by convention:

| Leg        | Question                                             | Where                                     |
| ---------- | ---------------------------------------------------- | ----------------------------------------- |
| **Origin** | Did this request come from our own pages?            | `src/lib/actions/origin.ts`               |
| **Auth**   | Who is calling, and are they allowed to call _this_? | `src/lib/actions/define-authed-action.ts` |
| **Input**  | Is the argument what the handler's types claim?      | the action's own Zod schema               |

They run in that order. Origin first because it is the cheapest and a request
that fails it should never have reached the process. Session before schema so an
anonymous caller learns "sign in" rather than a field-by-field description of the
payload that would have worked.

## The factories

Five, differing in the signature React requires at the call site:

```ts
defineAction           (input) => Promise<ActionResult<T>>
defineFormAction       (previous, formData) => Promise<ActionResult<T>>   // useActionState
defineNavigationAction (formData?) => Promise<void>                        // <form action>, redirects
defineAuthedAction     as defineAction, plus a non-nullable `user`
defineAuthedFormAction as defineFormAction, plus a non-nullable `user`
```

A typical action:

```ts
export const deletePostAction = defineAuthedAction({
  name: "deletePost",
  input: z.string().min(1, "A post id is required."),
  unauthenticatedMessage: "You must be signed in to delete a post.",
  handler: async ({ input: postId, user }) => {
    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) throw new ActionError("Post not found.");
    if (post.authorId !== user.id) {
      throw new ActionError("You can only delete your own posts.");
    }
    await prisma.post.delete({ where: { id: postId } });
  },
});
```

`input` is **required**, not optional. An action that takes nothing declares
`z.object({})` and says so; an optional schema is one every future action can
quietly decline, which is the whole failure mode.

Authentication is in the factory. **Authorisation is not** — "may this user touch
this row" is a question about the data, and it can only be answered next to the
query that loads it. That is why the ownership check above stays in the handler.

### Errors

- `throw new ActionError(message, fieldErrors?)` — a decision. Returned to the
  caller verbatim as the failure half of `ActionResult`.
- Anything else — a fault. Logged server-side with the action's `name`, replaced
  on the way out with a fixed sentence, because a Prisma error names tables and
  a `TypeError` names file paths.
- `redirect()` / `notFound()` — passed through untouched. They communicate by
  throwing, and a catch-all that swallowed one would turn a navigation into a
  silent no-op. See `isFrameworkSignal`.

A schema failure fills both channels: `fieldErrors` for the inputs that render
it, and `error` for the toast. When there is exactly one issue, `error` is that
issue's message rather than a generic sentence — every non-form caller shows only
`error`, and "File exceeds the 5 MB size limit." is worth more there than "Please
check your input."

### The typed-input trade

The action returned by a factory is typed against its schema's **input** type, so
call sites are checked at compile time:

```ts
createPostAction({ titel: "typo" }); // ← compile error
```

That is a convenience, not a guarantee — the value that actually arrives came
over the network. `safeParse` is what makes the type true, and the tests pass
deliberately-wrong values through a cast to prove it.

Where input legitimately arrives as runtime-widened data — a `File.type`, a
`string` prop — the _schema_ should say so with `z.string().pipe(z.enum([…]))`
rather than the call site casting. A bare `z.enum` has the union as its input
type, which pushes the check back out to the caller: exactly out of the one place
that enforces it.

## Origin checking, and what Next already does

Next 16 **does** check Server Action origins. `handleAction` compares the
`Origin` header's host against `x-forwarded-host` (preferred) or `host`, consults
`serverActions.allowedOrigins`, and aborts with `Invalid Server Actions request.`
on a mismatch. `src/lib/actions/origin.ts` does not replace that.

It has one gap, in the framework's own words:

```js
if (!originHost) {
  // This is a handcrafted request without an origin or a request from an
  // unsafe browser. We'll let this through but log a warning.
  warning = "Missing `origin` header from a forwarded Server Actions request.";
}
```

A request with **no `Origin` header at all** is allowed, and the only trace is a
line in the server log. So the single behavioural difference here is:

> **Absent means refused, where Next means allowed-with-a-warning.**

Browsers have sent `Origin` on cross-origin `POST`s for years, so this rejects
nothing a real browser sends.

The rest of the rules match the framework deliberately — `x-forwarded-host` takes
precedence over `host`, only the first hop of a forwarded chain is read, hosts
compare case-insensitively and include the port. The opaque `null` origin (a
sandboxed iframe, a `data:` document) is refused: it names no host, so it can
never legitimately match one.

### Configuration

`next.config.ts` deliberately leaves `serverActions.allowedOrigins` **unset**.
Empty is the framework's strictest setting, this check is strictly stricter, and
two allowlists for one property is how they drift. A deployment behind a proxy
that rewrites neither `host` nor `x-forwarded-host` sets:

```
ALLOWED_ACTION_ORIGINS=https://app.example.com,admin.example.com:8443
```

Full origins or bare hosts both work. No wildcards — an allowlist this repository
matches with an exact comparison is one whose behaviour is obvious from reading
it. A deployment that genuinely needs `*.example.com` should say so in
`next.config.ts`, where Next's own matcher supports it.

### Why per-action and not middleware

Because the other two legs are necessarily per-action, and a hardening story
split across two layers is one that gets half-applied.
`scripts/assert-action-hardening.ts` can prove that every export of every
`"use server"` module goes through a factory that performs all three; it could
prove nothing about a middleware that may or may not match the route an action
happens to be posted to.

## The gate

`scripts/assert-action-hardening.ts` runs in CI and enforces two rules:

- **A1** — every value exported from a `"use server"` module under `src/actions/`
  must be `export const <name> = <factory>({ … })`, or be listed in `EXEMPT` with
  a reason. `EXEMPT` is currently empty and worth keeping that way.
- **A2** — those factory names must actually be imported from
  `@/lib/actions/define-action` or `@/lib/actions/define-authed-action`. Without
  A2, a local function called `defineAction` satisfies A1 and means nothing.

Neither rule can prove a schema is strict _enough_ — that is what each action's
unit tests are for. They prove there is a schema, a session check and an origin
check at all, in one reviewable place.

## What the schemas caught

The two actions that had been shipped without one:

- **`getPresignedUploadUrlAction`** declared `input: PresignedUrlInput` and
  validated none of it. `filename` reached `filename.split(".").pop() ?? "bin"`
  and the result was interpolated straight into the S3 key, so a `filename` of
  `"a.png/../../other-user/evil"` produced an "extension" containing slashes and
  `..` and the object landed outside `uploads/<user id>/` — the only thing in
  that template doing any access control. `sizeBytes` was compared with a bare
  `>`, which `undefined`, `null` and `NaN` all pass.

  The extension is now derived from the **content type**, which is allowlisted
  _and_ signed into the presigned URL. No caller-supplied string reaches the key
  at all, which is a stronger property than sanitising one.

- **`deletePostAction`** passed its argument to `prisma.post.findUnique`
  untouched. A non-string threw out of the action rather than returning a failure
  the UI could show.

## Testing

`src/test/setup.ts` mocks `next/headers` to return a **same-origin** request, not
an empty `Headers`. An empty header set fails the origin check — correctly — so
defaulting to it would have made every action test assert the rejection path
while appearing to test the feature.

A test that wants another path says so:

```ts
import { setRequestHeaders } from "@/test/request-headers";

setRequestHeaders({ origin: "https://evil.example", host: "localhost:3000" });
```

It is reset to the same-origin default after every test.

## Not done

- **No rate limiting.** A hardened action still answers as fast as it is asked.
  That is its own SPEC item ("Rate limiting Server Actions and route handlers at
  the edge") and it is the fourth leg of this story.
- **No idempotency.** A double-submitted `createPostAction` still creates two
  posts; also its own SPEC item.
- **No E2E coverage of the origin check.** Asserting it end to end means posting
  a forged action request at a running server with a real encrypted action id,
  which is a larger piece of harness than this item. The rules are covered as a
  decision table in `src/lib/actions/origin.test.ts` instead.
