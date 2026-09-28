# Log redaction

A log line is the one place in a server where a value that may never leave the
process is written to a stream that is collected, shipped, indexed and retained
for a year, by a system whose access list is not the database's. Nothing in
TypeScript separates a string that is a post title from a string that is a
session cookie, so the only way to keep the second out of a log is to look at
what is being written, at the moment it is written, and refuse the values that
are shaped like a secret.

Two modules and two gates:

|                                     |                                                  |
| ----------------------------------- | ------------------------------------------------ |
| `src/lib/logging/redact.ts`         | decides what a line may contain                  |
| `src/lib/logging/logger.ts`         | the only module in `src/` that touches `console` |
| `no-console` in `eslint.config.mjs` | catches a direct write while it is being typed   |
| `scripts/assert-log-redaction.ts`   | catches everything a lint rule cannot            |

## The defect this started from

`src/lib/actions/define-action.ts` ended its catch block with

```ts
console.error(`[action] ${name} failed:`, thrown);
```

That frame wraps every Server Action in the application, `changePassword`
included. Node formats an `Error` with `util.inspect`, which prints the stack
**and every own enumerable property**, and a `pg` driver error carries the
statement it failed on in `detail`, `table`, `where` and friends. So the field
name under which a freshly derived password hash reaches stdout is `detail`,
inside a message nobody in this repository wrote, on a path that only runs when
the database is already having a bad day — which is also the moment somebody
turns log verbosity up.

`src/lib/auth/password-upgrade.ts` knew about this and worked around it locally
by reporting `error.name` and never `error.message`. The comment there says the
general fix is a separate item. This is it.

## Two rules, because they catch different things

The obvious design is a list of forbidden field names: drop `password`, drop
`token`, print the rest. That catches the log line somebody wrote on purpose and
misses every one that matters, because the lines that leak are the ones nobody
designed.

So the serialiser refuses on two independent grounds.

**By field name.** `password`, `secret`, `token`, `authorization`, `cookie`,
`apiKey`, `salt`, and the rest of `SECRET_KEY`. This is how a value with no
distinguishing shape is caught — a passphrase, a PIN, a recovery code. The key
is normalised first (`passwordHash` → `password_hash`), which is not cosmetic:
a case-insensitive `[^a-z]` boundary also excludes `A-Z`, so without the
normalisation `passwordHash` — the exact field name this application would put a
hash under — stops matching.

`key` on its own is deliberately **not** on the list. `src/lib/uploads/storage.ts`
writes `{"event":"upload.quarantine_delete_failed","key":"quarantine/…"}`, where
`key` is an S3 object key and the only thing in the line that says which object
failed. Only the qualified spellings — `apiKey`, `accessKey`, `secretKey`,
`privateKey` — are credentials.

**By shape.** JWS and JWE, PHC hashes, the legacy `hex.salt` hash this
repository used to write, PEM private keys, AWS access key ids, SigV4 query
parameters, a URL with a password in its authority, an `Authorization` header
value, and a catch-all for a long dense run of token characters.

Two details in that list are worth knowing because they are not what a rule
written from memory produces:

- The session cookie is a **five-segment JWE** whose second segment is **empty**
  — `@auth/core/jwt` uses `dir` key management, so there is no encrypted key. A
  pattern demanding three segments, or one demanding non-empty segments, refuses
  nothing this application actually issues.
- A presigned URL is refused **whole**, not just its signature. It is a
  capability: strip the signature and what remains still names the bucket, the
  key, the credential and the expiry.

## Whole values and substrings are separate passes

`classifySecret` decides what a value _is_. `redactText` takes secret-shaped
spans out of text that is otherwise fine. Both are needed, and the boundary
between them is load-bearing: unanchored, a 600-character driver message that
_mentions_ a hash classifies as a hash, and the whole message — the table, the
constraint, the stack beneath it — is replaced with one marker. That was a real
bug here, found by a test, and rule P3 of the gate is what keeps it fixed.

## What must survive

A log nobody can read is a log that gets turned off, and the way that happens is
an incident where the line that would have explained it says
`{"event":"auth.session","sid":"[redacted]"}`.

`sid` is a `crypto.randomUUID()` and is the correlation key of the auth audit
trail; every `id` in `prisma/schema.prisma` is a cuid. Both are high-entropy by
construction, so the entropy rule excludes UUID, cuid and ULID by name, and a
pathname is excluded by structure — `/` is in base64's alphabet, so
`/blog/what-server-components-actually-changed` reads as a token to any test
that does not notice it is words.

The cost of that exclusion, stated rather than implied: **a bearer token that is
a bare UUID passes the shape rules.** It is caught only if the field it sits
under is named like a credential. Do not mint one.

## Why the marker carries no digest

A tempting refinement is to replace a secret with a hash of itself, so two lines
about the same token can be correlated without printing it. It is not done here.
Half of what this module redacts is low-entropy — a password a person typed —
and an unsalted digest of one is a reversible artefact sitting in a log
aggregator, which is the thing being prevented, moved one function away. Salting
fixes that and breaks the use: the salt has to be per-process to be safe, and an
incident spans restarts.

The marker carries the shape that matched and the length of what it replaced:
`[redacted: jwt, 312 chars]`. Both help when reading a line, neither narrows a
guess.

## Writing a line

```ts
import { logError, logWarn } from "@/lib/logging/logger";

logError("action.failed", { action: name, error: thrown });
```

`event` is a dotted name from a closed union. It is closed because the thing
anybody does first with a log platform is filter, and a filter needs a value
that does not change when somebody rewords a sentence. `level` and `event` lead
the line and a field of either name is dropped rather than merged — a caller
that could overwrite them could file a line in another line's bucket.

A module that owns its own line shape — `src/lib/vitals/sink.ts`,
`src/lib/uploads/verify.ts`, both of which are interfaces a deployment replaces
— uses `writeLine(level, line)`. It gets the same trip through the serialiser.

A deployment with a transport passes its own writer:

```ts
setLogWriter({ error: ship, warn: ship, info: ship });
```

Tests use `captureLogs()` from `@/test/log-lines`, which returns the text that
would have reached stdout — redaction included. That is what makes "the log does
not contain the password" a statement a test can make; a `vi.spyOn(console,
"error")` asserts the call, and the call and the line stopped being the same
thing when the serialiser went between them.

## The two exceptions

Nine modules under `src/` may still touch the console, all of them
browser-only: the eight `error.tsx` boundaries and `src/lib/env/client.ts`. They
are listed in `CONSOLE_EXCEPTIONS` with a reason each, and in `eslint.config.mjs`
— rule R4 fails the build if the two lists disagree.

The argument is the same for all of them and it is about where the output goes.
Redaction exists to keep a secret out of a stream somebody collects; a browser
console is the console of the person who caused the error, holding a value
already in that browser's memory. Routing these through the serialiser would put
it, and its pattern table, into the client bundle to protect nothing.
`src/lib/env/client.ts` has a second and stronger reason: the only thing it can
print is a validation failure of a `NEXT_PUBLIC_*` variable, and a schema
containing no secrets is the entire purpose of the server/client env split. Rule
R2 checks that each exception still has the property its permission rests on.

## What a deployment still has to do

Nothing here alerts. `token_reuse` is raised to `error` and every other session
event stays at `warn` so that a stolen cookie and an expiry are distinguishable,
but routing the first somewhere a person sees is a log platform's job. The
events worth an alert:

| `event`                                        | `level` | means                                                                   |
| ---------------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `auth.session` with `"type":"token_reuse"`     | `error` | a token outside its family's chain was presented; the family is revoked |
| `password_change` with `"outcome":"incorrect"` | `error` | a signed-in caller guessing at the password of the account they are in  |
| `config.invalid`                               | `error` | the process refused to boot                                             |
| `upload.accepted` with `"scanned":false`       | `warn`  | objects are reaching the bucket with no scanner configured              |

## Not done

- **A secret passed to a client component as props** is serialised into the RSC
  payload and never goes near this module. `docs/server-only.md` says the same
  thing about the import boundary; neither layer sees it.
- **Third-party output is not covered.** A dependency that writes to stdout
  writes to stdout. The gate's scope is `src/`, because a rule over
  `node_modules` would be a rule nobody can act on.
- **`console` in the browser is not redacted**, by the argument above. A client
  component that fetched a token and logged it would print it to that user's own
  console.
- **Nothing rate-limits a log line.** A failure in a hot path writes one line
  per request, and the serialiser walks an object graph per line — bounded at
  depth 6 and 64 entries, but not free.
