# OWASP Top 10 (2021), category by category

This is the security posture of this boilerplate, written against the ten
categories OWASP publishes, and it is a **checked** document rather than a
narrative one: `scripts/assert-owasp-checklist.ts` runs in CI, parses this file,
and fails the build if a mitigation names a module that no longer exists, cites a
test that was deleted or renamed, claims something the tree does not support, or
defers to a spec item that has since been ticked.

That gate is the reason to trust the rows below more than you would trust prose.
A security checklist is the file in a repository most likely to be wrong and
least likely to be noticed being wrong: it is written once, when somebody is
thinking hardest about the subject, and from then on it is a set of claims nobody
re-derives. Binding it to the tree does not make the mitigations better. It makes
the document's decay a build failure.

## How to read a row

Each category has one or more **Mitigation** bullets. Each names the module that
does the work and cites at least one test that would fail if it stopped. Where
there is nothing to claim there is a **Gap** bullet instead, naming the `SPEC.md`
item that tracks it — so the day that item is finished, this gate fails and this
document has to be revisited.

No test is cited by two categories. That rule is in the gate (`C6`) because the
alternative is a checklist that looks complete while three of its rows rest on
one assertion.

## What this is not

It is not a penetration test, and a checklist is not evidence of one. Four rows
here rest on properties of the whole tree — no raw SQL, no unlisted outbound
`fetch`, an anchored image allowlist, a frozen supply chain — and those are
checked statically, which is a real guarantee about the source and no guarantee
at all about a deployment's infrastructure. Nothing here covers the database's
own access control, the CDN in front of the application, or the container it runs
in.

It also has nothing to say about denial of service. The rate limiter in
`src/lib/rate-limit/` bounds credential stuffing and expensive endpoints, which
is A04 and A07 work; it is not a defence against volume, and `docs/rate-limiting.md`
says so at more length.

---

### A01:2021 — Broken Access Control

The most-reported category on OWASP's list, and the one whose failures are least
visible in a test suite: a missing check does not throw, it answers 200. So the
approach here is that authorisation is not something a route _does_, it is
something a route's constructor already did. There is no handler in this
application that reads a session and decides; there are two factories that will
not run a handler until they have one.

- **Mitigation** — every authenticated route is built by `src/lib/api/define-authed-route.ts`, which resolves the session, rejects a session with no user id, and answers 403 rather than 401 for a role failure. The id is checked rather than assumed because Prisma reads `where: { id: undefined }` as _no filter_, not _no rows_.
  - **Test** `src/lib/api/define-authed-route.test.ts` › "answers 401 for a session whose user has no id"
  - **Test** `src/lib/api/define-authed-route.test.ts` › "answers 403 — not 401 — when a signed-in user lacks the required role"
- **Mitigation** — every mutation is built by `src/lib/actions/define-authed-action.ts`, whose handler receives a non-nullable `user`. An action that has to re-check what the guard established is an action where somebody eventually will not. The session is threaded as an argument and never through a module-scope variable, which is the version of this that looks tidier and is a cross-request auth-confusion bug.
  - **Test** `src/lib/actions/define-authed-action.test.ts` › "hands the handler a user that cannot be null"
  - **Test** `src/lib/actions/define-authed-action.test.ts` › "gives each concurrent call its own user"
- **Mitigation** — the route gate is `PROTECTED_PREFIXES` / `ADMIN_PREFIXES` in `src/auth.config.ts`, evaluated in the proxy ahead of the response rather than inside a layout. Next does not re-render a shared layout when navigating between siblings inside it, so a layout-level gate is a gate that runs once.
  - **Test** `src/proxy.test.ts` › "redirects all PROTECTED_PREFIXES to /login"
  - **Test** `src/proxy.test.ts` › "redirects USER to /forbidden for nested admin routes"
- **Mitigation** — object-level authorisation is in the query, not in a branch after it: `src/lib/dal/posts.ts` scopes by `authorId` and the ownership check in `src/actions/posts.ts` is what refuses somebody else's row. A filter in the `where` cannot be forgotten by a caller the way a comparison after the read can.
  - **Test** `src/actions/posts.test.ts` › "returns error when user does not own the post"
  - **Test** `src/lib/dal/posts.test.ts` › "puts the published filter in the query, not in the caller"
- **Mitigation** — every redirect destination goes through `src/lib/security/safe-redirect.ts`, which rejects a protocol-relative URL and its backslash and tab spellings. This is where A01's live defect was, and it was measured rather than reasoned about: against a production build of unmodified `main`, signed in, `GET /login?callbackUrl=//evil.example/phish` answered `302 Location: http://evil.example/phish`, the backslash spelling did the same, and `callbackUrl=//` answered **500** because `new URL("//", nextUrl)` throws. `https://evil.example` was refused — the one shape a `startsWith("/")` check does catch, and the only one the test that already existed covered.
  - **Test** `src/lib/security/safe-redirect.test.ts` › "rejects every shape the URL parser reads as another origin"
  - **Test** `src/proxy.test.ts` › "ignores a %s callbackUrl, which a leading-slash check accepts"
- **Mitigation** — the preview capability authorises one path, signed, rather than entering draft mode for whatever the caller appended. `src/lib/preview/token.ts` puts the destination inside the signature, so it is an output of verification rather than an input to it.
  - **Test** `src/lib/preview/token.test.ts` › "refuses to sign a path it would not redirect to"
- **Mitigation** — tenant isolation is enforced by the database, not by the query: `prisma/rls.sql` puts row-level security on every table with a `tenantId`, and `src/lib/tenancy/client.ts` scopes each statement to one workspace. This is the layer the `authorId` filter above cannot be: that filter protects the queries written with it in mind, and the next `findMany` somebody adds to a dashboard passes review, passes its test and passes CI, because in every environment it will be run in there is only one tenant's data to return. Under a policy it returns nothing instead.
  - **Test** `src/lib/dal/posts.test.ts` › "the dashboard list is scoped to the workspace it was asked for"
  - **Test** `src/lib/tenancy/client.test.ts` › "makes the setting transaction-local"
- **Mitigation** — the active workspace arrives in a cookie and is checked against `memberships` on every request, in `src/lib/tenancy/active.ts`. A cookie is a request rather than evidence, and signing one would only prove this server issued it — not that the membership still exists. A cookie naming a workspace the user is not in is refused rather than falling back to one they are, because answering a request for workspace B with workspace A's data shows a page on which every value is real and none of it is what the reader believes they are looking at.
  - **Test** `src/lib/tenancy/active.test.ts` › "refuses a cookie naming a tenant the user is not a member of"
  - **Test** `src/lib/tenancy/active.test.ts` › "consults the membership table on every call, not the cookie alone"
- **Mitigation** — whether the policies are enforced _at all_ is measured rather than assumed. Row-level security is skipped for a superuser and for a role with BYPASSRLS, with no error anywhere, so `scripts/assert-tenant-isolation.ts` creates two tenants against CI's Postgres and probes what a connection scoped to one can reach — and refuses to report on anything else until it has established that the connecting role cannot bypass what it is measuring. `docs/multi-tenancy.md` is the argument; **Gap** below records what it does not cover.
  - **Test** `scripts/assert-tenant-isolation.test.ts` › "T1 — reports a bypassing role and stops there"
  - **Test** `scripts/assert-tenant-isolation.test.ts` › "T8 — fires when the scope outlives its transaction"
- **Gap** — draft mode is a whole-site preview, so a preview token minted inside one workspace opens every workspace's unpublished posts. That is what draft mode has always done here; row-level security made it visible by requiring the access rule to be written down, as `posts_preview_read` in `prisma/rls.sql`. SPEC: Scope draft-mode preview to the tenant that minted the token

### A02:2021 — Cryptographic Failures

Three kinds of key material exist here — the session secret, the HMAC keys
derived from it, and password hashes — and the interesting decisions are about
derivation and comparison rather than about algorithm choice.

- **Mitigation** — every secondary key is HKDF-derived from one secret with a per-purpose `info` string, in `src/lib/crypto/hmac.ts`, so a preview-link key cannot verify a revalidation webhook and rotating the root secret rotates all of them.
  - **Test** `src/lib/crypto/hmac.test.ts` › "derives unrelated keys from one secret for different purposes"
  - **Test** `src/lib/crypto/hmac.test.ts` › "changes with the secret, which is what makes rotation work"
- **Mitigation** — passwords are scrypt-hashed with a per-password 16-byte salt and verified with `timingSafeEqual`, in `src/lib/password.ts`. The length check before the comparison is load-bearing: `timingSafeEqual` throws on a length mismatch rather than returning false.
  - **Test** `src/lib/password.test.ts` › "produces different hashes for the same password"
  - **Test** `src/lib/password.test.ts` › "returns false for a hash without a dot separator"
- **Mitigation** — the hash records the cost that produced it, in PHC string format (`$scrypt$ln=16,r=8,p=2$salt$key`), and `verifyPassword` derives at the parameters it reads out of the stored string rather than at the current policy. That is what makes the cost a line that can move: the parameters are `ln=16, r=8, p=2`, one of the equivalent configurations OWASP's Password Storage cheat sheet lists, chosen over `ln=17, r=8, p=1` because they cost the same (386 ms against 414 ms, measured) and peak memory halves with N — and Node runs `scrypt` on the libuv thread pool, so that number is multiplied by concurrency. See `docs/password-hashing.md`.
  - **Test** `src/lib/password.test.ts` › "derives at the hash's parameters and not at the current policy"
  - **Test** `src/lib/password.test.ts` › "records its own cost parameters in the hash"
- **Mitigation** — sign-in is verify-then-rehash: `@/lib/auth/password-upgrade` re-derives a below-policy hash from the plaintext the request is already holding, which is the only request in an account's life that has it. The write is `UPDATE … WHERE id = :id AND password = :verified`, so a password change landing between the read and the write wins instead of being silently reverted to a re-derivation of the old password, and a failure never refuses a sign-in that has already succeeded.
  - **Test** `src/lib/auth/password-upgrade.test.ts` › "re-derives a below-policy hash and writes it at the new cost"
  - **Test** `src/lib/auth/password-upgrade.test.ts` › "names the hash it verified against, so a concurrent change wins"
- **Mitigation** — hashes in the previous parameterless `hex.salt` format still verify, at the Node defaults that produced them, and report as needing a rehash. Losing that locks out every account older than the format change and is invisible in a fresh database, so `scripts/assert-password-hashing.ts` probe P2 re-derives one with the old implementation on every build.
  - **Test** `src/lib/password.test.ts` › "verifies a hash written by the previous parameterless format"
  - **Test** `scripts/assert-password-hashing.test.ts` › "P2 — fires when the previous format stops verifying"
- **Mitigation** — the parameters in a stored hash are an allocation size and a loop count, read on an unauthenticated POST, so they are bounded: `128 · r · (N + p + 2)` may not exceed 256 MiB and a hash outside that is refused rather than evaluated. `maxmem` is derived from the same expression, which is also what makes the cost raisable at all — Node defaults it to 32 MiB and refuses every parameter set above its own default N.
  - **Test** `src/lib/password.test.ts` › "returns false rather than allocating for a hash demanding gigabytes"
  - **Test** `src/lib/password.test.ts` › "raises the cost without help from maxmem, which Node defaults to 32 MiB"
- **Mitigation** — transport and cookie flags are a deployment fact rather than a per-request reading of `x-forwarded-proto`: `src/lib/auth/deployment.ts` pins them to the validated origin, and the session cookie takes the `__Host-` prefix, which additionally forbids a `Domain` and so cannot be set by a sibling subdomain.
  - **Test** `src/lib/auth/deployment.test.ts` › "never carries a Domain, which __Host- forbids"
  - **Test** `src/lib/auth/deployment.test.ts` › "is decided by the pinned origin and not by NODE_ENV"
- **Mitigation** — HSTS is sent on every TLS response, with `includeSubDomains` and a two-year window, from `src/lib/security/headers.ts`. Not `preload`: that is months to reverse and applies to every subdomain, which is a decision about somebody's DNS rather than a default a boilerplate gets to make.
  - **Test** `src/lib/security/headers.test.ts` › "sends HSTS on an https request"
  - **Test** `src/lib/security/headers.test.ts` › "does not ask for preload, which is not a boilerplate's decision"

### A03:2021 — Injection

No string-built queries and no HTML sink. The claim worth making here is
therefore an absence, and an absence across a repository is not something a unit
test can assert — so the gate checks it directly.

- **Mitigation** — every query goes through Prisma's builder, which parameterises. Two modules are exempt and both are enumerated in `RAW_SQL_CALL_SITES` with the reason: `src/lib/tenancy/client.ts` issues `SELECT set_config(<name>, <value>, TRUE)` to open a tenant scope, and `src/lib/tenancy/enforcement.ts` issues one constant, parameterless catalogue query. Prisma's builder models rows, not session state, so neither has a non-raw spelling. Both use tagged templates, so every interpolated value is a bind parameter; neither uses an `Unsafe` variant, and `scripts/assert-owasp-checklist.ts` fails the build on any other module that issues a raw query — and on a stale entry in the list.
  - **Test** `scripts/assert-owasp-checklist.test.ts` › "finds a raw query anywhere in the source"
  - **Test** `scripts/assert-owasp-checklist.test.ts` › "fires on a stale allowlist entry"
  - **Test** `scripts/assert-owasp-checklist.test.ts` › "still fires on an unlisted module that uses the unsafe form"
  - **Test** `src/lib/tenancy/client.test.ts` › "passes the values as bind parameters, not as SQL text"
- **Mitigation** — input is parsed at the edge by Zod and handlers receive parsed values, in `src/lib/api/define-route.ts`. A schema failure is a 422 naming the offending field, not a handler defending itself.
  - **Test** `src/lib/api/define-route.test.ts` › "answers 422 with the offending field prefixed by its source"
  - **Test** `src/lib/api/define-route.test.ts` › "answers 422 when a dynamic segment is missing or renamed"
- **Mitigation** — there is no `dangerouslySetInnerHTML` and no markdown renderer: `src/lib/prose.ts` splits stored post bodies into paragraphs and React escapes each one. Parsing user content as markup would mean a parser and a sanitiser, which is a decision this boilerplate declines rather than gets wrong.
  - **Test** `src/lib/prose.test.ts` › "keeps text that looks like markup as text"
- **Mitigation** — the Content Security Policy is the second layer if the first ever fails: nonce plus build-time digests, no `unsafe-inline`, no `unsafe-eval`, from `src/lib/security/csp.ts`. `docs/csp.md` has the measurements behind the shape it takes.
  - **Test** `src/lib/security/csp.test.ts` › "has no 'unsafe-inline', 'unsafe-eval' or 'strict-dynamic'"
- **Mitigation** — a `Location` header cannot be split, because `src/lib/security/safe-redirect.ts` rejects control characters in a redirect target outright.
  - **Test** `src/lib/security/safe-redirect.test.ts` › "rejects control characters, which split a Location header"

### A04:2021 — Insecure Design

The category with no single mechanism, so the entries here are the design
decisions that would each be a class of bug if taken the other way: retries that
write twice, concurrent edits that silently lose one, an endpoint whose cost is
unbounded, and a file upload that believes what it was told about itself
(CWE-434, which is this category's).

- **Mitigation** — a double submission is one write and two identical answers: `src/lib/actions/idempotency.ts` keys on a client-supplied key scoped to the authenticated principal, and fingerprints the input so a reused key with different input is a conflict rather than a wrong replay.
  - **Test** `src/lib/actions/idempotency.test.ts` › "distinguishes values JSON.stringify collapses"
  - **Test** `src/lib/actions/idempotency.test.ts` › "encodes dates by their instant"
- **Mitigation** — concurrent edits are resolved by version, not by arrival order: `src/lib/concurrency/post-conflict.ts` merges disjoint field edits and reports a genuinely contested field with all three values rather than picking one.
  - **Test** `src/lib/concurrency/post-conflict.test.ts` › "reports a field both sides changed, with all three values"
- **Mitigation** — the rate limiter runs before anything else in `src/proxy.ts`, keyed on an identity a caller cannot rewrite: `src/lib/rate-limit/client-identity.ts` counts back from the right of `x-forwarded-for` and collapses an IPv6 `/64`, because everything left of the entry our own infrastructure wrote is client-supplied.
  - **Test** `src/lib/rate-limit/enforce.test.ts` › "cannot be reset by rewriting the left of x-forwarded-for"
  - **Test** `src/lib/rate-limit/enforce.test.ts` › "cannot be reset by rotating IPv6 hosts inside one /64"
- **Mitigation** — a write and the events it emits commit together or not at all, through the outbox in `src/lib/outbox/write.ts`. A cache invalidation that happens for a transaction that rolled back is a design failure that presents as a data bug.
  - **Test** `src/lib/outbox/write.test.ts` › "does not dispatch when the transaction aborts"
  - **Test** `src/lib/outbox/write.test.ts` › "refuses an emit that arrives after the transaction closed"
- **Mitigation** — an uploaded object is accepted on its _bytes_, not on its name: `src/lib/uploads/sniff.ts` reads the leading bytes against the four formats' documented signatures and `src/lib/uploads/verify.ts` refuses anything whose sniffed type is not the type S3 stored it as. Sniffing against the stored `Content-Type` rather than against a type the caller re-declares is what makes the check mean something — the stored header is what a browser is eventually told these bytes are.
  - **Test** `src/lib/uploads/verify.test.ts` › "refuses an HTML document stored as image/png and deletes it"
  - **Test** `src/lib/uploads/verify.test.ts` › "compares against the type S3 stored, not one the caller re-declares"
- **Mitigation** — the allowlist cannot grow past the sniffer: `ALLOWED_MIME_TYPES` in `src/lib/uploads/policy.ts` holds only types with a signature, which is enforced by rule R1 of `scripts/assert-upload-validation.ts`. `image/svg+xml` is refused for exactly that reason — SVG is XML, a well-formed SVG carrying `<script>` is a well-formed SVG, and no byte pattern separates a drawing from a document.
  - **Test** `src/lib/uploads/policy.test.ts` › "no longer accepts image/svg+xml"
  - **Test** `scripts/assert-upload-validation.test.ts` › "fails when image/svg+xml is put back on the allowlist"
- **Mitigation** — the 5 MB cap is enforced twice against things the caller does not control: `content-length` is signed into the presigned PUT (`src/lib/s3.ts`), so S3 refuses a body of any other length, and `verifyUploadedObject` re-measures the stored object from the readback's `Content-Range` before promoting it. Before this, the cap was checked against a declared number that was then discarded, and the URL it minted authorised a PUT of any size.
  - **Test** `src/lib/s3.test.ts` › "produces a different signature when only the length changes"
  - **Test** `src/lib/uploads/verify.test.ts` › "measures the stored object rather than believing the declared size"
- **Mitigation** — nothing is readable until it has been verified. The presign writes to a key under the `quarantine` prefix and returns no URL the object can be read from; `finalizeUploadAction` copies it under the public `uploads` prefix only after the size, the sniff and the scan agree, and deletes what it refuses.
  - **Test** `src/lib/uploads/verify.test.ts` › "promotes a verified object and returns its public URL"
  - **Test** `src/lib/uploads/policy.test.ts` › "writes to the quarantine prefix, never the public one"
- **Mitigation** — the antivirus hook is a seam with an explicit failure policy rather than a bundled engine: `src/lib/uploads/scan.ts` refuses the upload when a _configured_ scanner does not answer, and accepts it while recording `"scanned": false` at `warn` when none is configured. A scanner that reports a timeout as clean is worse than no scanner, so `unavailable` is a distinct verdict from `clean` and cannot be produced by the upload path.
  - **Test** `src/lib/uploads/scan.test.ts` › "refuses a non-answer from a configured scanner"
  - **Test** `src/lib/uploads/scan.test.ts` › "treats an unrecognised body as unavailable, never as clean"

### A05:2021 — Security Misconfiguration

Before this item, a response from this application carried a Content Security
Policy and nothing else — no `nosniff`, no HSTS, no referrer or permissions
policy. A header nobody owns is a header nobody notices the absence of, which is
this category in one sentence.

- **Mitigation** — `src/lib/security/headers.ts` sets the five fixed hardening headers on every response the proxy returns, refusals and redirects included. `X-Frame-Options: DENY` is there specifically because `frame-ancestors 'none'` is _not_ enforced in the two states this application can legitimately be deployed in — `CSP_REPORT_ONLY=1`, and a production server with no hash manifest, which degrades to report-only on purpose rather than serve an outage.
  - **Test** `src/lib/security/headers.test.ts` › "always sends nosniff, DENY, a referrer policy and a permissions policy"
  - **Test** `src/proxy.test.ts` › "hardens a rate-limit refusal"
- **Mitigation** — the environment is validated by a Zod schema at import time in `src/lib/env/server.ts`, so a deployment missing a secret fails to boot rather than running with `undefined` where a key should be.
  - **Test** `src/lib/env/server.test.ts` › "still rejects a short one"
- **Mitigation** — secrets cannot reach a client bundle: `import "server-only"` on the modules that hold them, an ESLint rule for the raw `process.env` read that has no import to mark, and `scripts/assert-server-only.ts` for what neither sees. `docs/server-only.md` has the three layers and what each one catches that the others do not.
  - **Test** `scripts/assert-server-only.test.ts` › "fails when the env module loses the marker"
- **Mitigation** — an unexpected server error is an opaque 500: `src/lib/api/errors.ts` passes a declared `ApiError` through and redacts everything else, so a stack trace or a driver message is never the response body.
  - **Test** `src/lib/api/errors.test.ts` › "redacts anything else behind an opaque 500"
- **Mitigation** — the policy a caller sends is stripped rather than forwarded, in `src/lib/security/apply.ts`. An inbound `content-security-policy` header is read by Next as the policy for that render, so forwarding it lets the caller choose the nonce their own script would be stamped with.
  - **Test** `src/lib/security/apply.test.ts` › "sets the policy Next reads the nonce out of, plus the x-nonce copy"
  - **Test** `src/proxy.test.ts` › "replaces a client-supplied policy rather than forwarding it"

### A06:2021 — Vulnerable and Outdated Components

The one category with no code to test. A dependency's vulnerability is in
somebody else's source and did not exist when the version was pinned, so there is
no assertion to write — only a process, and the checkable properties of the setup
that process needs.

`pnpm audit` is deliberately **not** a pull-request gate. A new advisory against
a transitive package would turn every unrelated pull request red, in a repository
whose rule is that a red check is never merged, which trains people to merge red.
Dependabot points the failure at the thing that changed instead.

- **Mitigation** — `.github/dependabot.yml` opens weekly pull requests for both the npm tree and the workflow actions, grouped so the volume is reviewable. Every CI install is `--frozen-lockfile` and `packageManager` is pinned to an exact pnpm version, so the tree CI resolves is the one the lockfile records. The gate checks all four of those properties.
  - **Test** `scripts/assert-owasp-checklist.test.ts` › "fails a CI install that is not frozen to the lockfile"
  - **Test** `scripts/assert-owasp-checklist.test.ts` › "fails when dependabot stops covering an ecosystem"
- **Gap** — nothing here scans for a _known_ advisory against the currently pinned tree; Dependabot's security updates are the only signal, and they arrive on GitHub's schedule rather than this repository's. A scheduled (not per-pull-request) audit workflow whose failure opens an issue is the shape that would fit. SPEC: A scheduled dependency-advisory audit that opens an issue rather than failing a pull request

### A07:2021 — Identification and Authentication Failures

Sessions are the part of this application with the most written down about it,
because the item before this one found that they did not work in a production
build at all. `docs/session-hardening.md` is the long version; these are the
properties.

- **Mitigation** — a session is a family with a rotating token: `src/lib/auth/harden.ts` rotates every 15 minutes of use, and a token that is neither current nor the one just replaced revokes the whole family. That turns a stolen cookie from a credential into a race, and the losing side is what gets noticed.
  - **Test** `src/lib/auth/harden.test.ts` › "revokes the family when the replaced token comes back too late"
  - **Test** `src/lib/auth/harden.test.ts` › "revokes on a token that was never in the chain at all"
- **Mitigation** — the rotation grace window is a concurrency allowance and not a hole: `src/lib/auth/policy.ts` accepts the replaced token for 30 seconds, because a single page load issues parallel slot, prefetch and streamed-boundary requests that all still carry it.
  - **Test** `src/lib/auth/harden.test.ts` › "serves the replaced token inside its grace window"
  - **Test** `src/lib/auth/harden.test.ts` › "lets exactly one win and serves the other normally"
- **Mitigation** — there is an absolute deadline as well as the sliding idle window, enforced from the `sat` claim in `src/lib/auth/claims.ts` rather than from the registry row, so it holds when the database does not. A sliding window alone never expires a session somebody else is using.
  - **Test** `src/lib/auth/harden.test.ts` › "ends a session that has been active throughout"
  - **Test** `src/lib/auth/harden.test.ts` › "is enforced before the registry is consulted"
- **Mitigation** — credential stuffing is bounded at 10 attempts a minute per client, and the rule counts NextAuth's own callback endpoint. That endpoint is directly reachable — fetch `/api/auth/csrf` and post to the callback — and for as long as `api/auth` was excluded from the proxy matcher, every guess ran a full password verification uncounted.
  - **Test** `src/lib/rate-limit/enforce.test.ts` › "counts NextAuth's own credentials endpoint against the same budget"
  - **Test** `src/proxy.test.ts` › "covers NextAuth's endpoints"
- **Mitigation** — revocation is server-side state, not a cleared cookie: `src/lib/auth/registry.ts` makes the rotation a conditional update and keeps the first revocation reason, so signing out ends the row rather than only the browser that asked.
  - **Test** `src/lib/auth/registry.test.ts` › "will not revive a family revoked between the read and the write"
  - **Test** `src/lib/auth/registry.test.ts` › "keeps the first revocation reason"
- **Gap** — there is no password-change or "sign out everywhere" action, so the registry's per-user revocation has no caller. `docs/session-hardening.md` writes out the query rather than shipping a method nothing calls. SPEC: Sign out everywhere: a password-change action that revokes every session for a user

### A08:2021 — Software and Data Integrity Failures

Two inbound integrations accept instructions from outside — the revalidation
webhook and the preview link — and both are signed. The third concern is the
integrity of a write against the events it emits.

- **Mitigation** — the revalidation webhook is HMAC-signed with a timestamp inside the signed material, in `src/lib/webhooks/signature.ts`, so a captured request cannot be replayed with a refreshed timestamp and a stale one is refused outside a tolerance window.
  - **Test** `src/lib/webhooks/signature.test.ts` › "rejects a timestamp moved forward to refresh a captured request"
  - **Test** `src/lib/webhooks/signature.test.ts` › "rejects a signature older than the tolerance window"
- **Mitigation** — preview links are capabilities signed over their own destination, verified before draft mode is entered, in `src/app/api/preview/route.ts`. The redirect target comes out of the verified payload and never out of the request.
  - **Test** `src/lib/preview/token.test.ts` › "rejects a token whose payload was edited"
- **Mitigation** — a transaction's side effects are recorded in the same transaction and dispatched after it commits, so a cache invalidation cannot describe a write that was rolled back. `src/lib/outbox/store.ts` is the claim-and-process half.
  - **Test** `src/lib/outbox/write.test.ts` › "writes the rows and the events in one transaction"
- **Mitigation** — no workflow pins an action to a moving branch, and the action versions are themselves a tracked dependency through `.github/dependabot.yml`. The gate fails a `@main`.
  - **Test** `scripts/assert-owasp-checklist.test.ts` › "fails an action pinned to a moving branch"
- **Gap** — the actions are pinned to major tags, not to commit digests, so a tag can be moved by its publisher. Digest pinning plus Dependabot's digest updates is the stronger form; it is a change to every workflow step and belongs with the CI work rather than here. SPEC: Pin every GitHub Action to a commit digest, with Dependabot digest updates

### A09:2021 — Security Logging and Monitoring Failures

The failure mode this category names is a log that exists and tells nobody
anything, so what is asserted here is the shape of the line rather than the fact
of writing one.

- **Mitigation** — every security-relevant session event is one parseable JSON line tagged `auth.session`, from `src/lib/auth/harden.ts`, with a session id to correlate on. `token_reuse` is raised to `error` and the policy events stay at `warn`, because a channel where an expiry and a stolen cookie look the same is a channel people stop reading.
  - **Test** `src/lib/auth/harden.test.ts` › "raises token_reuse to error, and leaves the policy events at warn"
  - **Test** `src/lib/auth/harden.test.ts` › "writes one parseable JSON line per event, tagged auth.session"
- **Mitigation** — a token presented that was never in a family's chain is recorded as reuse specifically, not as a generic revocation, so the trail distinguishes an incident from a policy outcome after the fact.
  - **Test** `src/lib/auth/harden.test.ts` › "records TOKEN_REUSE rather than a generic revocation"
- **Mitigation** — telemetry is structured by construction: `src/lib/vitals/sink.ts` writes one JSON line per metric with a discriminator to filter on, which is the default rather than a disabled state when no collector is configured.
  - **Test** `src/lib/vitals/sink.test.ts` › "writes a parseable line carrying the discriminator"
  - **Test** `src/lib/vitals/sink.test.ts` › "writes one JSON line per metric, not one per batch"
- **Gap** — there is no redaction layer, so a future log line that interpolates a token or a hash would publish it, and nothing here alerts: `token_reuse` goes to `console.error` and it is the deployment's job to route it somewhere a person sees. Both are named in `docs/server-only.md` as out of scope for the boundary work. SPEC: Log redaction: a serialiser that refuses to print a secret-shaped value

### A10:2021 — Server-Side Request Forgery

This application performs almost no outbound requests, which is the mitigation —
but "almost none" is a property that decays one feature at a time, so it is
enforced rather than asserted. Upload verification is the first feature that made
the count go up, and the three rows it added are what that enforcement looks like
when it is working: each new call site had to be argued for in
`FETCH_CALL_SITES` before the build would pass.

One thing here is a deployment's to settle rather than this repository's, and it
is written down in `docs/uploads.md` rather than left implied: an accepted object
is served from the bucket's own URL, and a deployment that fronts that bucket with
a CDN alias on its application domain turns every upload into same-site content.
That is why the bucket policy in that document keeps the quarantine prefix private,
and why `image/svg+xml` is refused outright rather than sanitised.

- **Mitigation** — the set of modules that call `fetch` is enumerated in `scripts/assert-owasp-checklist.ts`, and each entry records why its target cannot be chosen by a caller. A new call site anywhere in `src/` fails the build and has to be argued for in that list. Today there are three: the vitals forwarder, whose target is `serverEnv.VITALS_COLLECTOR_URL`, and two browser-side hooks on literal same-origin paths.
  - **Test** `scripts/assert-owasp-checklist.test.ts` › "fails a fetch call site that is not on the list"
  - **Test** `scripts/assert-owasp-checklist.test.ts` › "fails a list entry that no longer fetches"
- **Mitigation** — the one request this server makes on a caller's instruction is the image optimiser's, and `next.config.ts` bounds it: every `remotePatterns` entry is https with a hostname anchored to a domain. A `hostname: "**"` there turns `/_next/image?url=…` into an open proxy, so the gate refuses one.
  - **Test** `scripts/assert-owasp-checklist.test.ts` › "fails an unanchored image hostname"
  - **Test** `scripts/assert-owasp-checklist.test.ts` › "fails a remote pattern that allows plain http"
- **Mitigation** — the collector URL is validated as a URL by the environment schema at boot and is not reachable from a request, so the forwarder's destination is a deployment decision rather than an input.
  - **Test** `src/lib/vitals/sink.test.ts` › "selects the log sink when no collector is configured"
- **Mitigation** — the gap this section used to record is closed, and it became the call sites it predicted. Verifying an upload means reading the object back, so `src/lib/uploads/storage.ts` now fetches — but only URLs it presigns itself, whose host is built from `S3_BUCKET_NAME` and `AWS_REGION`. There is no position in such a URL for a caller-supplied hostname, and the key is checked by `parseObjectKey` and its user segment compared with the session's own id before any request is made, so the readback cannot be aimed at another user's object either.
  - **Test** `src/lib/uploads/storage.test.ts` › "aims the request at the bucket's host, with no caller input in it"
  - **Test** `src/actions/upload.test.ts` › "refuses another user's key without reading it"
- **Mitigation** — the readback is bounded to a 512-byte `Range`, so an upload cannot make this server pull five megabytes into a Server Action to look at eight bytes of it. The object's real length is taken from the response's `Content-Range` rather than from a second request.
  - **Test** `src/lib/uploads/storage.test.ts` › "requests only the header bytes"
  - **Test** `src/lib/uploads/storage.test.ts` › "takes the length from Content-Range, not from the slice's Content-Length"
- **Mitigation** — the malware scanner is the fourth call site and its target is `serverEnv.UPLOAD_SCANNER_URL`, validated as a URL at boot and reachable from no request. The request body carries the object's bucket and key and no URL at all, so the scanner cannot be pointed at something either: it reads the object itself, which is also why the bytes are never streamed through this process.
  - **Test** `src/lib/uploads/scan.test.ts` › "sends the bytes nowhere — only the object's location"

---

## What was verified against a running server

The unit suite is not the only evidence here. Both of this item's code changes
were probed against `pnpm build && pnpm start`, because both are about what
leaves the process rather than about what a function returns:

- The five hardening headers arrive on a document (`/`) and on a JSON route
  (`/api/health`). `strict-transport-security` is absent over plain HTTP and
  present as `max-age=63072000; includeSubDomains` when `x-forwarded-proto:
https` says a proxy terminated TLS.
- The open redirect, signed in, on unmodified `main`:
  `GET /login?callbackUrl=//evil.example/phish` →
  `302 Location: http://evil.example/phish`; the `/\evil.example` spelling the
  same; `callbackUrl=//` → `500`. On this branch all three answer
  `302 Location: http://localhost:3000/dashboard`, and `/posts?tab=drafts` still
  arrives intact.

## Running the gate

```
tsx scripts/assert-owasp-checklist.ts
```

It needs no build output. CI runs it in the build job with the other assertions,
and `scripts/assert-owasp-checklist.test.ts` checks each rule against the failure
it names, by breaking a copy of the tree rather than by trusting that the rule
reads correctly.
