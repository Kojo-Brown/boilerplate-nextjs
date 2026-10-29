# TDD kata: a Server Action, red → green → refactor

This is the write-up of one Server Action built test-first, one commit per step.
The feature is real and shipped — `signOutEverywhereAction`, on
`/settings/security` — and the commits are on the pull request that added it:

| Step         | Commit                                                       | Diff                |
| ------------ | ------------------------------------------------------------ | ------------------- |
| **red**      | `test: the cases "sign out everywhere" has to satisfy, …`    | 1 file, +122        |
| **green**    | `feat: sign out of every session, the simplest thing that …` | 1 file, +32         |
| **refactor** | `refactor: move the revocation behind a store, …`            | 6 files, +394 / −42 |

The squash merge collapses them, which is why the diffs that matter are quoted
below rather than only referenced.

Two things here are not the kata and are called out where they appear: a gate
bug the green step uncovered, and the form that makes the action reachable.

## Why this feature

Revoking every session for an account was possible only as a side effect of
changing its password. `changeUserPassword` verifies a current password before
it writes anything and answers `no_password` when there is none to verify —
which is every account that signs in through Google. Such an account could not
revoke a stolen session cookie at all: the cookie kept working until the
session's absolute deadline, a week.

So the feature is the revocation without the credential. It is small enough to
build in three commits and has exactly one interesting decision, which is the
ordering of its two effects.

## Red

The first commit is six failing cases and no implementation. They are the
decisions the action makes:

```
✗ refuses an anonymous caller before revoking anything
✗ refuses a cross-origin post
✗ revokes every live family of the session's own user
✗ signs this browser out once the revocation has landed
✗ reports success when the revocation committed but the sign-out failed
✗ does not sign this browser out when the revocation failed
```

`pnpm vitest run src/actions/account.test.ts` → **6 failed, 13 passed**. The
thirteen are `changePasswordAction`'s, and their staying green is part of what
the run is reporting: the new cases fail for the one reason they should
(`signOutEverywhereAction is not a function`) rather than because the file
stopped loading.

The last two cases are the pair worth copying. Either one alone is satisfied by
a handler that has the two effects backwards:

- sign out first, then revoke — and a revocation that fails leaves the person
  signed out of the one session they were holding while every session they
  asked to end carries on, with the form reporting success;
- revoke, then report a failed sign-out as a failure — and a person whose
  sessions are already gone is told to try again, which is the one thing that
  cannot work.

One case fixes the order; one case fixes what a failure after the commit point
means. Neither is reachable by asserting "it revokes".

What those six cases deliberately do **not** assert is the behaviour of the
layers the action stands on: the origin check is `origin.test.ts`'s, the
factory's session read is `define-authed-action.test.ts`'s. The two refusals
here are about this action's own wiring — that it reaches neither the database
nor the sign-out when refused, and that the anonymous sentence is its own
rather than the factory's default.

## Green

The second commit is the smallest thing that passes: one statement in the
handler.

```ts
handler: async ({ user }): Promise<void> => {
  await unscopedPrisma.sessionFamily.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: "REVOKED_BY_USER" },
  });

  await endThisBrowsersSession();
},
```

**19 passed.** And the tree does not build:

```
✗ [R4] src/actions/account.ts reads outside a tenant scope and is not in
       `UNSCOPED_READERS`.
```

That is the step's lesson, and the reason it is a commit rather than a stage
somebody skips. "Green" is a statement about the unit suite and about nothing
else. Twenty-eight CI gates in this repository check properties no test can
see, and rule R4 of `scripts/assert-tenant-isolation.ts` is one of them: a
reach for the named unscoped client has to carry the argument for why its table
is untenanted, and `src/actions/` is not where that argument gets reviewed.

### The gate that should have refused it too, and did not

R1 of `scripts/assert-cache-invalidation.ts` requires every action that
performs a Prisma write to report the write or be exempt with a reason. It said
nothing about the handler above, because its `CLIENT_NAMES` set held `prisma`
and `tx` — not `unscopedPrisma`, the name `@/lib/tenancy/client` re-exports the
singleton under precisely so that unscoped access is greppable.

The hole was latent rather than live: the tree's only other unscoped action
write, in `registerAction`, happens inside `unscopedPrisma.$transaction` and so
arrives through `tx`. It is fixed in its own commit, with the handler above as
the test case, and verified the way this repository verifies a gate — by
removing the name again and watching the new case report `[]` where it should
report one finding.

That commit is not part of the kata. It is what the kata found.

## Refactor

The statement moves to `src/lib/auth/session-revocation.ts`, parameterised over
a store, a reporter and a clock — the shape `@/lib/auth/password-change`
already uses. The action keeps the hardening and the sign-out and calls a
library:

```ts
handler: async ({ user }): Promise<void> => {
  await revokeEverySession({ userId: user.id }, sessionRevocation);

  await endThisBrowsersSession({
    action: "signOutEverywhere",
    committed: "the revocation committed",
  });
},
```

R4 is satisfied by the module's entry in `UNSCOPED_READERS`, where the reason
can be read next to the eight others. What the move actually buys is on the
test side, and it is measurable: the statement now has four cases of its own
(the predicate key, the `revokedAt: null` that stops a `TOKEN_REUSE` family
being relabelled, the injected instant, the returned count) where it had one,
and none of them goes through two layers of hardening to reach the assertion.

### What the refactor cost the tests

Five of the six cases were untouched. One was rewritten:

```diff
-    expect(mockRevoke).toHaveBeenCalledWith({
-      where: { userId: "user-42", revokedAt: null },
-      data: { revokedAt: expect.any(Date), revokedReason: "REVOKED_BY_USER" },
-    });
+    expect(mockRevoke).toHaveBeenCalledWith(
+      { userId: "user-42" },
+      expect.anything(),
+    );
```

The five that survived assert what the action _decides_. The one that changed
asserted the shape of a `where` clause — a fact about the collaborator, reached
through the action. A test that names a collaborator is a test the next
refactor has to touch, and the version above is both shorter and more honest
about which file owns what: the predicate is now asserted in
`session-revocation.test.ts`, which is where the predicate lives.

This is the part of red → green → refactor that gets left out of kata
write-ups. The refactor step is not free, it is not invisible to the suite, and
the bill arrives in proportion to how much the tests knew about the
implementation. Five-sixths of these did not need to know.

## What the kata did not produce

The form. `SignOutEverywhereForm` and its mount on `/settings/security` are a
separate commit, written the ordinary way, because an action with no caller is
unreachable — a defect this repository has shipped before, with `ThemeToggle`'s
eight passing tests and no mount. It is noted here so the kata's three commits
are not read as the whole pull request.

## Doing it again

The shape generalises to any mutation in this repository:

1. **Name the decisions, not the statements.** Write the cases for what the
   action chooses: what it refuses, where its arguments come from, what order
   its effects run in, what a failure after the commit point means. Those cases
   outlive the implementation.
2. **Write the crude version and run the gates, not just the suite.** The
   gates are where this repository keeps the properties a test cannot see. A
   green suite over a build that fails is the normal state of a green step, and
   it is information, not an embarrassment.
3. **Let the refactor be the one the gate demands.** This one was not a matter
   of taste; R4 refused the placement. Where no gate has an opinion, the test
   bill from the previous section is the next best signal: a case you have to
   rewrite to move a statement is a case that was asserting the statement.
