# Multi-tenancy

Tenant isolation here is enforced by Postgres, not by the queries. This
document is the argument for that; `prisma/rls.sql` is the mechanism and
`scripts/assert-tenant-isolation.ts` is what keeps it true.

## The problem with doing it in the `where` clause

This repository already had the careful version. `getEditablePost` filters on
`authorId`, `getPublishedPostById` filters on `published`, and the comments on
both explain why the filter is in the query rather than in the component — a
rule that lives three modules from the data is one `||` away from serving
somebody else's draft, and that is not hypothetical here: adding draft mode
once relaxed a page's guard and made unpublished posts publicly readable.

That argument has a limit, and the limit is the whole reason for this feature.
A filter protects the queries that were written with it in mind. The next
`findMany` somebody adds to a dashboard component is one missing clause away
from reading another customer's rows, and it will pass review, pass its test,
and pass CI — because in every environment it will ever be run in, there is
only one tenant's data to return. The bug ships, and the first evidence is a
support ticket from the customer who saw it.

Row-level security inverts the default. The filter is a property of the
connection, so a query that forgets it returns **nothing** rather than
everything, and the mistake surfaces on the first run instead of the first
customer.

## The shape

Three access worlds, and which one a query is in is visible at its import.

| World        | How it is opened                                          | What it can reach                                      |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------ |
| Tenant scope | `tenantClient(scope)` / `withTenantTransaction(scope, …)` | every row of one workspace, read and write             |
| Unscoped     | `unscopedPrisma`                                          | published posts, read only; plus the untenanted tables |
| Preview      | `withPreviewRead(…)`                                      | every post including drafts, read only, no tenant      |

`src/lib/tenancy/client.ts` owns all three. `scripts/assert-tenant-isolation.ts`
rule R3 stops anything else importing `@/lib/prisma` directly, and R4 requires
every use of the second and third to be enumerated with a reason — because
`unscopedPrisma.post.findMany` is exactly as unscoped as `prisma.post.findMany`
and differs only in saying so.

## How a scope is opened

Every statement on a scoped client runs inside a transaction whose first two
statements are:

```sql
SELECT set_config('app.tenant_id', $1, TRUE);
SELECT set_config('app.user_id',   $2, TRUE);
```

The policies read those settings through `app.current_tenant_id()` and
`app.current_user_id()`.

**The `TRUE` is the whole safety property.** It makes the setting
transaction-local. The session-level form (`SET app.tenant_id = …`, or
`set_config(…, FALSE)`) survives until the connection closes, and a pool hands
that same connection to the next request — which may be a different tenant, or
the public blog. That is not a subtle ordering problem: with a pool of one it
happens on the very next statement. It is also one character away from correct,
which is why rule T8 measures it against a live server rather than trusting the
code to keep saying `TRUE`.

The cost is a transaction per statement. The alternative — a connection pool
per tenant, which is the other way to make a session-level setting safe — does
not survive a thousand tenants.

### Interactive transactions

A mutation is several statements that must be one unit, so it cannot use the
scoped client: that client wraps each statement in a transaction of its own,
and Postgres has no nested transaction to give it. `withTenantTransaction`
opens the scope as the first statements _inside_ one transaction instead, and
`writeWithOutbox` takes a `scope` and uses it. A write with no scope is refused
by the database rather than landing in the wrong workspace — there is no
INSERT, UPDATE or DELETE policy that matches an unscoped connection.

## Who decides which tenant

`src/lib/tenancy/active.ts`. The active workspace arrives in a cookie and is
checked against `memberships` on every request.

The cookie is a **request**, not evidence. Signing it would not change that: a
signature proves this server issued the value, and says nothing about whether
it is still true — and the whole point of checking is that memberships get
revoked. A signed tenant cookie is a capability with no expiry.

For the same reason the tenant is not a JWT claim, which is the other obvious
place for it. The session token is re-minted only on rotation, so a claim would
go stale for up to fifteen minutes after a membership was removed, and every
layer below would be reading a workspace the database no longer agrees with.
`src/lib/auth/claims.ts` is deliberately four claims that say nothing about the
user; this would have been a fifth that said a great deal.

A cookie naming a workspace the user is not a member of resolves to `null`, and
**not** to their first workspace. Falling back would answer a request that
explicitly asked for workspace B with workspace A's data — a page on which
every value is real and none of it is what the reader believes they are looking
at, which is far harder to notice than an error.

## The failure nobody sees: a connection that bypasses everything

Row-level security is **not applied to a superuser**, and **not applied to a
role with `BYPASSRLS`**. Neither is a warning, a notice, or an error. The
policies exist, `pg_policies` lists them, `\d posts` prints them, every query
succeeds — and every row comes back. A deployment whose `DATABASE_URL` points
at `postgres` has exactly as much tenant isolation as one with no policies at
all, and there is nothing on any screen to tell the two apart.

That was the state of this repository the first time these policies were
applied: `.env.example` shipped a `postgres` URL, CI's Postgres service
container has one role, the whole suite passed, and nothing was enforced.

Two things follow, and both are in the tree rather than in a runbook:

1. `prisma/rls.sql` creates a dedicated `app_rls` role — `NOSUPERUSER`,
   `NOBYPASSRLS`, DML only — and re-asserts those attributes on every apply.
   The application connects as it; the policies are installed by an
   administrative connection, which is what stops a compromised application
   connection from simply turning them off. A table's owner can
   `ALTER TABLE … DISABLE ROW LEVEL SECURITY`, and the application is
   deliberately not the owner.
2. `app.rls_bypass_reasons()` asks the database, **as the application's own
   role**, why the policies would not bind it. Empty means enforced.
   `src/lib/tenancy/enforcement.ts` wraps it, rule T1 runs it in CI before
   anything else, and it stops there when it finds something — because every
   other probe would otherwise report nonsense for reasons unrelated to the
   policies being wrong.

There is one more variant of the same trap. `ENABLE ROW LEVEL SECURITY` does
not apply to the table's **owner** unless the table is also `FORCE`d — and
under `prisma db push` the owner is whichever role ran the push, which in a
great many deployments is the role the application connects as. Every table
here is forced, and rule R1 fails the build on one that is enabled and not.

## Applying the policies

`prisma db push` reconciles tables, columns and indexes and is entirely unaware
that policies exist. It will not drop them — re-running it is safe — but it
will happily create a **new** table with row-level security off, and nothing
about that looks wrong. So:

```bash
export DATABASE_ADMIN_URL=postgresql://postgres@localhost:5432/nextjs_db
pnpm exec prisma db push   # tables
pnpm db:rls                # policies, role, grants  (idempotent)
pnpm db:rls:verify         # prove it
```

`pnpm db:rls:verify` is `scripts/assert-tenant-isolation.ts`. Without a
`DATABASE_URL` it runs the static rules and says so; with one it also creates
two tenants, probes what a connection scoped to the first can reach, and
removes the fixture. CI runs both halves.

Set `APP_DB_PASSWORD` when applying and `app_rls` gets that password. The
policy file creates the role without one, because a password in a committed
file is a committed credential.

## What the gate checks

Static, over the tree:

- **R1** every model with a `tenantId` has its table enabled, **forced**, and
  policied. This is the rule for the most likely future mistake: adding a
  tenant-scoped model is one line, and `db push` gives it no protection.
- **R2** the setting names in `src/lib/tenancy/scope.ts` are the ones the
  policies read. A mismatch has no symptom — `set_config` writes a setting
  nothing reads, `current_setting` returns NULL, and every scoped query quietly
  becomes an unscoped one.
- **R3** nothing imports `@/lib/prisma` outside the enumerated modules.
- **R4** every unscoped or preview read is enumerated, with its reason.
- **R5** every `writeWithOutbox` in `src/actions/` passes a scope.

Live, against CI's Postgres, with two tenants and four posts:

- **T1** the connecting role cannot bypass the policies. _Nothing else runs
  until this passes._
- **T2** a scoped read sees its own workspace's rows and no others' — including
  no others' **published** rows, which is what the `IS NULL` conjunct on
  `posts_public_read` is for.
- **T3** a scoped `UPDATE` matches nothing in another workspace.
- **T4** a row cannot be moved into another workspace.
- **T5** an unscoped connection sees published posts only.
- **T6** an unscoped connection cannot write at all.
- **T7** draft mode can see drafts.
- **T8** the scope does not survive its transaction.
- **T9** a member cannot enumerate another workspace's memberships.
- **T10** the "which workspaces may I open" read returns only the asking user's.
- **T11** that same read can resolve the tenants it names.

Each is checked against the failure it names in
`scripts/assert-tenant-isolation.test.ts`, and T1, T2, T4, T9 and T10 were also
checked by sabotaging a real database in exactly that way and watching them
fire.

### The bug a running build found

T11 exists because of a defect that every unit test passed over. The "which
workspaces may I open" read happens **before** any tenant scope exists — it is
what decides the scope — and it joins `tenants` for the slug and name it has to
display. With only the obvious policy on that table
(`USING (id = app.current_tenant_id())`), that join matched nothing, because
there is no tenant yet.

A join against a row no policy makes visible is a `NULL`, not an error. So the
symptom was `TypeError: Cannot read properties of null (reading 'slug')` on
every signed-in request against a production build, while the whole suite was
green — a mocked membership row comes with its tenant attached, so no unit test
could have seen it. `tenants_member_read` is the fix: you may read a tenant you
are a member of, SELECT only, with the membership as the predicate rather than
the tenant id.

The wider lesson is the one this repository keeps relearning. A policy set is
not only a list of things to forbid: every read the application makes _before_
it has a scope needs a rule of its own, and those are exactly the reads that
cannot be tested without a database.

### One thing that was measured and turned out to be false

The usual advice is that a policy needs `WITH CHECK` as well as `USING`,
because `USING` alone would let a scoped connection move one of its own rows
into another tenant. **That is not true for the policies here**, and it was
checked rather than repeated: Postgres defaults an omitted `WITH CHECK` to the
`USING` expression, so `FOR ALL USING ("tenantId" = app.current_tenant_id())`
with no `WITH CHECK` refuses the move. Writing `WITH CHECK (true)` explicitly
_still_ refuses it. Only `USING (true) WITH CHECK (true)` lets it through.

Both clauses are written out anyway, because the defaulting stops covering the
gap the moment somebody splits the policy into separate SELECT / INSERT /
UPDATE policies — which is the natural thing to do when the read rule and the
write rule need to differ. The property itself does not rest on the spelling:
T4 performs the move against a live database and fails the build if it
succeeds.

## The threat model, stated plainly

Row-level security here defends against **the application's own missing `where`
clauses**. It does not defend against an attacker who can execute arbitrary SQL
on the application's connection: such an attacker can open any tenant scope
they like, and no policy in this file prevents it. That is not a weakness of
the design, it is its boundary — the mitigations for SQL injection are in
`docs/owasp-top-10.md` under A03, and they are what keeps that attacker out.

## What is deliberately not tenant-scoped

- `users` — a person is a member of several workspaces, not owned by one.
  What a workspace may _learn_ about a user is bounded by which rows it can
  read, not by this table.
- `session_families` — a sign-in belongs to a user across every workspace;
  scoping it would make signing out workspace-specific.
- `outbox_events` — an outbox row describes a write that has already
  committed, and the relay that drains it runs with no session at all.
- `idempotency_keys` — scoped by its own `scope` column (`user:<id>`),
  deliberately not by a tenant.

## Known gaps

**Draft-mode preview reads across tenants.** `/blog` in draft mode shows every
workspace's unpublished posts to whoever holds a valid preview token, whichever
workspace minted it. This is not new — it is what draft mode has always done
here — but row-level security made it visible, by requiring the access rule to
be written down as `posts_preview_read` rather than being the default behaviour
of a connection with no restrictions. The fix is to put the tenant in the
preview token and scope the read to it; tracked in `SPEC.md`.

**Provisioning runs on the administrative connection.** Creating a tenant
cannot happen inside a tenant scope — there is no scope yet — and `tenants` has
no INSERT policy, so an unscoped connection cannot do it either. That seam is
deliberate and it means `registerAction` needs a connection that may insert a
tenant. In a deployment where the application role cannot, registration fails
loudly rather than half-creating an account. The two ways to close it are a
second connection for provisioning, or a `SECURITY DEFINER` function that
creates a tenant and its owner's membership as one checked operation; this
repository ships neither by default, because both are deployment decisions.

**No tenant-aware caching key.** The public blog's cache entries are keyed by
path and hold published posts from every workspace, which is correct for a
shared public blog and would be wrong for per-workspace public sites. See
`docs/cache-invalidation.md` for how the tags are built.
