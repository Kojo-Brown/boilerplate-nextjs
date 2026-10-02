-- Row-level security for the tenant-scoped tables.
--
-- Applied by `pnpm db:rls` (scripts/apply-rls.ts) after `prisma db push`, and
-- verified end to end against a real Postgres by `pnpm db:rls:verify`
-- (scripts/assert-tenant-isolation.ts), which is a CI gate. See
-- docs/multi-tenancy.md for the argument; this file is the mechanism.
--
-- ## Why this is a hand-written SQL file and not part of the Prisma schema
--
-- Prisma has no way to express a policy. `prisma db push` reconciles tables,
-- columns and indexes and is entirely unaware that these objects exist — which
-- also means it will not drop them, so re-running it is safe. What it will do
-- is create a *new* table with RLS disabled, and that is the failure mode this
-- file's companion gate exists for: a tenant-scoped table added to the schema
-- and not added here is unprotected, and nothing about it looks wrong.
--
-- ## Idempotent on purpose
--
-- Every statement is `IF NOT EXISTS`, `OR REPLACE`, or a `DROP POLICY IF
-- EXISTS` followed by a `CREATE POLICY`. The script that applies it runs on
-- every CI build and on every developer's `db:reset`, and a file that can only
-- be applied to a virgin database is a file that stops being applied.
--
-- The drop-then-create for policies is deliberate rather than lazy: Postgres
-- has no `CREATE OR REPLACE POLICY`, and `CREATE POLICY IF NOT EXISTS` does not
-- exist either, so the only way to make an *edited* predicate take effect is to
-- replace the policy. Skipping the create when one is already there would mean
-- a tightened predicate silently not being applied to any database that already
-- had the old one — every database that matters.

BEGIN;

-- ---------------------------------------------------------------------------
-- The scope a connection is operating in
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS app;

-- The tenant the current transaction is scoped to, or NULL for none.
--
-- `current_setting(..., true)` — the `true` is "missing_ok". Without it this
-- raises `undefined_object` on any connection that has not set the GUC, which
-- is every connection serving the public blog, so the policies below would
-- error rather than return no rows. A setting that has never been set and one
-- set to the empty string both mean "no tenant", and `NULLIF` collapses them:
-- `set_config` cannot store a NULL, so releasing a scope writes `''`.
--
-- `STABLE` and not `IMMUTABLE`: the value depends on the session state, so the
-- planner may cache it within one statement and must not fold it into a plan
-- that outlives the statement. `IMMUTABLE` would let a cached plan carry one
-- transaction's tenant into another's, which is the whole vulnerability.
--
-- `SET search_path = ''` and schema-qualified names throughout. A SECURITY
-- INVOKER function does not strictly need it, but a policy predicate is code
-- the database runs on every row of every query, and leaving its name
-- resolution up to the caller's `search_path` is how a function gets shadowed.
CREATE OR REPLACE FUNCTION app.current_tenant_id()
  RETURNS text
  LANGUAGE sql
  STABLE
  SET search_path = ''
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')
$$;

COMMENT ON FUNCTION app.current_tenant_id() IS
  'The tenant the current transaction is scoped to, or NULL. Set by @/lib/tenancy/client via set_config(..., true), which is transaction-local.';

-- The user the current transaction is acting for, or NULL.
--
-- A separate setting rather than something derived from the session: the
-- database connection is pooled and shared, so it has no user of its own.
--
-- Defined here, beside the tenant accessor, rather than next to the
-- `memberships` policies that were its first caller. That is not tidiness — it
-- is the fix for a broken build. This file is sent to Postgres as one
-- multi-statement query, so a policy referencing a function the file has not
-- defined *yet* fails with `function app.current_user_id() does not exist`.
-- It failed only on a *fresh* database: every re-apply to a database that
-- already had the function succeeded, which is precisely the "a file that can
-- only be applied to a database that already has the previous version" trap
-- this file's header warns about, arriving from the other direction. Both
-- accessors now live in this section, so the ordering cannot rot again, and
-- rule R6 in `scripts/assert-tenant-isolation.ts` fails on any `app.*`
-- function used above its own definition.
CREATE OR REPLACE FUNCTION app.current_user_id()
  RETURNS text
  LANGUAGE sql
  STABLE
  SET search_path = ''
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.user_id', true), '')
$$;

COMMENT ON FUNCTION app.current_user_id() IS
  'The user the current transaction is acting for, or NULL. Set alongside app.tenant_id by @/lib/tenancy/client.';

-- The tenant whose unpublished posts the current transaction may read, or NULL.
--
-- The draft-mode capability, and the reason it is a tenant rather than a flag.
-- This setting was `app.preview` holding the string `'on'` until the preview was
-- scoped: a boolean capability has exactly one meaning, "every workspace's
-- drafts", so a token minted inside one workspace opened all of them. Carrying
-- the tenant *in* the capability rather than beside it is what makes that
-- unrepresentable — there is no value of this setting that means "all of them",
-- and no second setting to forget to write.
--
-- A third accessor rather than reusing `app.current_tenant_id()`, because the
-- two must not be the same value. `app.tenant_id` is a *scope*: it narrows every
-- statement, on every table, for all four commands. This one widens one table's
-- SELECT and nothing else. Setting the scope instead would hand a bearer
-- capability — held, by design, by someone who may have no account — the
-- dashboard's own INSERT, UPDATE and DELETE rights.
--
-- `STABLE`, `SET search_path = ''` and `NULLIF`, for the reasons given above
-- `app.current_tenant_id()`; the `NULLIF` matters most here, since `set_config`
-- cannot store a NULL and releasing the capability therefore writes `''`.
CREATE OR REPLACE FUNCTION app.preview_tenant_id()
  RETURNS text
  LANGUAGE sql
  STABLE
  SET search_path = ''
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.preview_tenant_id', true), '')
$$;

COMMENT ON FUNCTION app.preview_tenant_id() IS
  'The tenant whose drafts the current transaction may read, or NULL. Set by withPreviewRead in @/lib/tenancy/client, from the signed cookie @/lib/preview/scope mints.';

-- ---------------------------------------------------------------------------
-- The application role
-- ---------------------------------------------------------------------------
--
-- RLS is not enforced for a superuser, and it is not enforced for a role with
-- BYPASSRLS. Neither of those is a warning anybody sees: the policies exist,
-- `pg_policies` lists them, every statement succeeds, and every row comes back.
-- A deployment whose DATABASE_URL points at `postgres` therefore has exactly as
-- much tenant isolation as one with no policies at all, and looks identical.
--
-- So the application gets its own role, created here rather than left to a
-- runbook, and `app.assert_rls_enforced()` below refuses to pass for a
-- connection that can bypass what this file installs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_rls') THEN
    -- No password: the grant is by connection privilege, and a password
    -- committed to a repository is a credential committed to a repository.
    -- Deployments set one out of band; `scripts/apply-rls.ts` sets one from
    -- APP_DB_PASSWORD when that is present.
    CREATE ROLE app_rls LOGIN;
  END IF;
END
$$;

-- NOSUPERUSER and NOBYPASSRLS are re-asserted on every apply rather than only
-- at creation: this is the property the whole file rests on, and a role that
-- was granted one of them by hand between deploys is the one case worth
-- catching. NOINHERIT keeps a future `GRANT app_rls TO someone` from carrying
-- privileges implicitly.
ALTER ROLE app_rls NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

GRANT USAGE ON SCHEMA public TO app_rls;
GRANT USAGE ON SCHEMA app TO app_rls;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO app_rls;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO app_rls;
GRANT EXECUTE ON FUNCTION app.preview_tenant_id() TO app_rls;

-- DML only. The application never issues DDL: `prisma db push` and this file
-- are applied by an administrative connection, which is what keeps a
-- compromised application connection from simply turning the policies off —
-- a table's owner can `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`, and the
-- application is deliberately not the owner.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rls;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rls;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rls;

-- ---------------------------------------------------------------------------
-- posts
-- ---------------------------------------------------------------------------

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
-- FORCE is what makes ENABLE mean anything to the table's owner. Without it,
-- policies are skipped for the role that owns the table — and under
-- `prisma db push` that is whichever role ran the push, which in a great many
-- deployments is the same role the application connects as.
ALTER TABLE public.posts FORCE ROW LEVEL SECURITY;

-- Everything a scoped connection may do, in one policy because the predicate is
-- the same for all four commands and three copies of one rule is three chances
-- to edit two of them.
--
-- `USING` is the read filter and also what an UPDATE or DELETE may *find*;
-- `WITH CHECK` is what an INSERT or UPDATE may *leave behind*.
--
-- Writing both is deliberate, and the reason is narrower than the obvious one.
-- The obvious claim — that `USING` alone would let a scoped connection move
-- one of its own rows into another tenant — is **false here**, and was checked
-- rather than assumed. Postgres defaults an omitted `WITH CHECK` to the
-- `USING` expression, so `FOR ALL USING ("tenantId" = app.current_tenant_id())`
-- with no `WITH CHECK` refuses `UPDATE posts SET "tenantId" = '<other>'`
-- exactly as this does. Measured against a real server: with `WITH CHECK
-- (true)` written out explicitly the move is *still* refused, and only
-- `USING (true) WITH CHECK (true)` lets it through.
--
-- What writing it out buys is that the protection stops being automatic the
-- moment somebody splits this into separate SELECT / INSERT / UPDATE policies,
-- which is the natural thing to do when the read rule and the write rule need
-- to differ. At that point each new policy carries whatever `WITH CHECK` it
-- was given, the defaulting no longer covers the gap, and an author who
-- learned the rule from a policy that stated it is far likelier to restate it.
-- The property itself is not left to the spelling: rule T4 in
-- `scripts/assert-tenant-isolation.ts` performs the move against a live
-- database and fails the build if it succeeds, however the policy is written.
DROP POLICY IF EXISTS posts_tenant_scope ON public.posts;
CREATE POLICY posts_tenant_scope ON public.posts
  FOR ALL
  USING ("tenantId" = app.current_tenant_id())
  WITH CHECK ("tenantId" = app.current_tenant_id());

-- The public blog, which has no tenant and must not acquire one.
--
-- `/blog` is served to anonymous visitors, prerendered at build time and
-- revalidated by a background request; none of those has a member whose tenant
-- could scope the connection, and inventing one would mean the public site
-- reading through a scope granted to nobody.
--
-- Postgres ORs permissive policies, so this widens what an unscoped connection
-- can see and deliberately not what a scoped one can: the `IS NULL` conjunct is
-- what keeps tenant A's connection from reading tenant B's published posts
-- through this policy. Without it, "published" would be a hole in the isolation
-- the other policy provides, and the dashboard reads through the same tables.
--
-- SELECT only. There is no INSERT, UPDATE or DELETE policy that matches an
-- unscoped connection, so a write that forgot to open a tenant scope is refused
-- by the database rather than landing somewhere unexpected.
DROP POLICY IF EXISTS posts_public_read ON public.posts;
CREATE POLICY posts_public_read ON public.posts
  FOR SELECT
  USING (published AND app.current_tenant_id() IS NULL);

-- Draft mode: a whole-site preview of exactly one workspace.
--
-- Whole-site because that is what draft mode is — a preview link shows a
-- reader their colleagues' drafts as well as their own, which is the point of
-- previewing a *site* rather than a post. One workspace because the alternative
-- is every workspace, and for as long as this policy tested a boolean
-- (`app.preview = 'on'`) that is what it meant: a token minted inside one
-- workspace opened every other workspace's unpublished posts. That was recorded
-- here and in docs/multi-tenancy.md as an open gap, tracked against A01 in
-- docs/owasp-top-10.md, and this predicate is what closes it. The tenant travels
-- in the signed token (`@/lib/preview/token`) and then in a signed cookie
-- (`@/lib/preview/scope`), because there is nobody to ask at read time: the
-- holder of a preview link may have no account at all.
--
-- Three conjuncts' worth of narrowness, and each one is load-bearing.
--
-- **`FOR SELECT`.** The capability is granted to a bearer token, so it must not
-- carry a write. There is no INSERT, UPDATE or DELETE policy an unscoped
-- connection matches, which is what makes that true rather than intended.
--
-- **`app.current_tenant_id() IS NULL`.** The preview capability cannot be used
-- from inside a tenant scope, so it can never widen one: a connection scoped to
-- tenant A that also set this setting to tenant B still sees only A's rows,
-- which rule T13 in `scripts/assert-tenant-isolation.ts` measures against a live
-- server. Without the conjunct, the dashboard's own connection would be one
-- `set_config` away from reading another workspace.
--
-- **`"tenantId" = app.preview_tenant_id()`.** Fails closed by construction, and
-- not by a check somebody remembered to write: the accessor maps an unset or
-- empty setting to NULL, `"tenantId" = NULL` is NULL rather than true, and a
-- NULL `USING` result refuses the row. So a preview that names no workspace —
-- a missing scope cookie, a forged one, a release that forgot to set the
-- setting — reads the published site rather than everything. T12 is that probe.
--
-- The threat model this is honest about: row-level security defends against
-- the application's own missing `where` clauses, not against an attacker who
-- can run arbitrary SQL on the application's connection. Such an attacker can
-- open any tenant scope they like, and this policy is not what lets them.
DROP POLICY IF EXISTS posts_preview_read ON public.posts;
CREATE POLICY posts_preview_read ON public.posts
  FOR SELECT
  USING (
    app.current_tenant_id() IS NULL
    AND "tenantId" = app.preview_tenant_id()
  );

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
--
-- A scoped connection sees exactly one tenant row: its own. That is less
-- obviously necessary than the policy on `posts` — a tenant's name and slug are
-- close to public — and it is here because the table is an enumeration of every
-- customer of the deployment, which is a thing competitors buy.
--
-- No INSERT policy. Creating a tenant is the one operation that cannot be
-- performed inside a tenant scope (there is no scope yet to create it in), so
-- it goes through the administrative path in `@/lib/tenancy/provision`, and the
-- absence of a policy here is what stops it being done any other way.

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_self_read ON public.tenants;
CREATE POLICY tenants_self_read ON public.tenants
  FOR SELECT
  USING (id = app.current_tenant_id());

-- The tenants a user is a member of, readable before any scope exists.
--
-- Found against a running production build, not reasoned out. With only the
-- policy above, `@/lib/tenancy/active` — which reads `memberships` with a user
-- and deliberately no tenant, because it is the read that *decides* the
-- tenant — got its membership rows and a NULL for every joined `tenant`: the
-- policy above matches nothing when `app.current_tenant_id()` is NULL, and a
-- LEFT JOIN against no visible row is a NULL rather than an error. The symptom
-- was `TypeError: Cannot read properties of null (reading 'slug')` on every
-- signed-in request, and every unit test passed, because a mocked membership
-- row comes with its tenant attached.
--
-- So the bootstrap read needs its own rule, and this is the narrowest one that
-- serves it: you may read a tenant you are a member of. SELECT only, and the
-- membership is the predicate rather than the tenant id, so it grants exactly
-- what "which workspaces may I open" needs and nothing else. It does not
-- recurse through `memberships_own_read` — that policy tests only
-- `app.current_user_id()` and references no table.
DROP POLICY IF EXISTS tenants_member_read ON public.tenants;
CREATE POLICY tenants_member_read ON public.tenants
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM public.memberships m
       WHERE m."tenantId" = tenants.id
         AND m."userId" = app.current_user_id()
    )
  );

DROP POLICY IF EXISTS tenants_self_update ON public.tenants;
CREATE POLICY tenants_self_update ON public.tenants
  FOR UPDATE
  USING (id = app.current_tenant_id())
  -- Renaming the tenant is allowed; changing which tenant the row *is* is not.
  WITH CHECK (id = app.current_tenant_id());

-- ---------------------------------------------------------------------------
-- memberships
-- ---------------------------------------------------------------------------
--
-- Scoped to the tenant, so a member of tenant A cannot enumerate tenant B's
-- members — the table that maps people to workspaces is the one that answers
-- "who else uses this product".
--
-- This table is also read *outside* any tenant scope, by
-- `@/lib/tenancy/active`, which has to answer "which tenants may this user
-- open" before a scope exists to ask it in. That read goes through
-- `withUserTransaction`, is the only unscoped read of this table in the
-- application, and is why the policy below has an explicit user branch rather
-- than being tenant-only: the alternative is an unscoped connection that can
-- read every membership row in the installation.
--
-- `app.current_user_id()` is defined at the top of this file, with the tenant
-- accessor; see the note there for why both live in one place.

ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memberships_tenant_scope ON public.memberships;
CREATE POLICY memberships_tenant_scope ON public.memberships
  FOR ALL
  USING ("tenantId" = app.current_tenant_id())
  WITH CHECK ("tenantId" = app.current_tenant_id());

-- "Which tenants may I open" — the read that precedes every scope.
--
-- SELECT only, and only the asking user's own rows. It cannot be used to list a
-- tenant's members (that needs `tenant_id`, which this branch does not test)
-- and it cannot be used to grant anything (no INSERT, and the row it returns is
-- the one the user already has).
DROP POLICY IF EXISTS memberships_own_read ON public.memberships;
CREATE POLICY memberships_own_read ON public.memberships
  FOR SELECT
  USING ("userId" = app.current_user_id());

-- ---------------------------------------------------------------------------
-- The self-check
-- ---------------------------------------------------------------------------
--
-- Returns the reasons the *calling* role would not have these policies
-- enforced against it, as rows — empty means enforced. A function rather than a
-- document because both of its findings are invisible from inside the
-- application: a superuser connection and a correctly scoped one behave
-- identically until the day two tenants exist.
--
-- SECURITY INVOKER (the default) is required: it has to report on whoever is
-- calling, and a DEFINER function would report on its owner every time.
CREATE OR REPLACE FUNCTION app.rls_bypass_reasons()
  RETURNS TABLE (reason text)
  LANGUAGE sql
  STABLE
  -- CURRENT_USER is a reserved keyword rather than a schema-qualified call, so
  -- it cannot be shadowed and does not need one.
  SET search_path = ''
AS $$
  SELECT 'role ' || pg_catalog.quote_ident(r.rolname) || ' is a superuser, which is never subject to row-level security'
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = CURRENT_USER AND r.rolsuper
  UNION ALL
  SELECT 'role ' || pg_catalog.quote_ident(r.rolname) || ' has BYPASSRLS'
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = CURRENT_USER AND r.rolbypassrls
  UNION ALL
  -- The owner of a table is exempt from its policies unless the table is
  -- FORCEd. Every table this file touches is forced, so this branch reports a
  -- table that acquired RLS somewhere else — or one whose FORCE was dropped.
  SELECT 'table ' || pg_catalog.quote_ident(c.relname)
         || ' has row-level security enabled but not forced, and '
         || pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(c.relowner))
         || ' owns it'
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relrowsecurity
     AND NOT c.relforcerowsecurity
     AND pg_catalog.pg_get_userbyid(c.relowner) = CURRENT_USER
$$;

COMMENT ON FUNCTION app.rls_bypass_reasons() IS
  'Empty when row-level security is actually enforced against the calling role. Checked at boot by @/lib/tenancy/enforcement and in CI by scripts/assert-tenant-isolation.ts.';

GRANT EXECUTE ON FUNCTION app.rls_bypass_reasons() TO app_rls;

COMMIT;
