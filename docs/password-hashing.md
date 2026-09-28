# Password hashing

Passwords are hashed with scrypt, in a format that records the cost that
produced each one, and every sign-in re-derives a hash that has fallen behind
the current policy. `src/lib/password.ts` owns the format;
`src/lib/auth/password-upgrade.ts` owns the upgrade; `src/auth.ts` is the only
caller of either.

## Why the format is the feature

The previous implementation stored `hex.salt` and derived with
`scrypt(password, salt, 64)` — Node's defaults, unrecorded. That is a correct
hash and an unraisable one. Nothing in the string says what work produced it,
so reading one back means repeating whatever the code happens to do today,
which means the parameters can never change. Raising them is not a deployment,
it is a migration that invalidates every account at once.

That failure is invisible. Every test passes, every sign-in works, and the cost
simply stays at whatever was normal the year the module was written.

So the hash carries its own parameters, in PHC string format:

```
$scrypt$ln=16,r=8,p=2$Q/Dl/3YfT2SOL+KerFocxw$UmjU/nb+JgEr1vrodbBHKRUkXzem20h1HdQ86/N8XPc
```

`ln` is log2 of scrypt's `N`; both trailing fields are unpadded standard
base64, as the format specifies. `verifyPassword` derives with the parameters
it reads out of the stored string, so an old hash keeps verifying at the cost
it was made at, and the key length comes from the stored key rather than from a
constant, so a change to `KEY_BYTES` does not invalidate anything either.

## A second thing pinned the old cost

`crypto.scrypt` defaults `maxmem` to 32 MiB and refuses any parameter set
needing more — with `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`, at call time. scrypt's
working set is `128 · r · (N + 2)` bytes, which at Node's default `N = 2^14,
r = 8` is 16 MiB; one step up to `N = 2^15` is 32 MiB and throws. Measured on
Node 22:

```
$ node -e '…scrypt("pw","salt",64,{N:2**15,r:8,p:1})…'
ERR_CRYPTO_INVALID_SCRYPT_PARAMS: memory limit exceeded
```

So a format that records the parameters is necessary and not sufficient:
`maxmem` has to be derived from them too. It is, and that derivation is
OpenSSL's own accounting — `128 · r · (N + 2)` for the scratch vector plus
`128 · r · p` for the blocks walked over it — plus a megabyte of slack, so that
a build whose OpenSSL counts slightly differently allocates a little more
rather than throwing on every verification.

The usual shorthand for that expression, `128 · N · r`, is the first term with
the `+ 2` dropped. That is a rounding error at `N = 2^16` and is larger than the
whole allocation at `N = 2`, which is why the tests — which hash at the cheapest
parameters the module accepts — are what caught it.

## Why these parameters

OWASP's Password Storage cheat sheet gives a row of equivalent scrypt
configurations. Measured here, on one core:

| parameters         | peak memory | time   |
| ------------------ | ----------- | ------ |
| `N=2^17, r=8, p=1` | 128 MiB     | 386 ms |
| `N=2^16, r=8, p=2` | 64 MiB      | 414 ms |
| `N=2^15, r=8, p=3` | 32 MiB      | 261 ms |

`PASSWORD_HASH_POLICY` is the second row and not the first, deliberately. They
cost an attacker the same; peak memory is `128 · N · r` and halves with N. That
difference is multiplied by concurrency, because Node runs `scrypt` on the libuv
thread pool — four derivations in flight by default, so the choice is between
512 MiB and 256 MiB of transient allocation on a box also running the renderer.
`p` is the parallelism parameter in name only here: OpenSSL walks the p blocks
sequentially, so raising it buys work without buying memory, which is the trade
a shared server wants.

A 414 ms verification is a rate limiter's problem before it is a hash
function's. Credential stuffing is bounded separately, at 10 attempts a minute
per client, and that rule counts the NextAuth callback endpoint directly — see
`docs/rate-limiting.md`.

The policy is a constant and not an environment variable. The point of
recording the parameters is that this line can move; an env var would instead
make the cost a per-deployment accident, and the failure it invites is one-way,
because nobody notices a deployment that quietly hashes at `ln=10`.

## Raising the cost

1. Change `PASSWORD_HASH_POLICY` in `src/lib/password.ts`.
2. Check the new working set against `MAX_WORKING_SET_BYTES`, the ceiling in
   the same file. At the current policy there is room for one step of `ln`, or
   for `r` to go from 8 to 16; a second step means moving that line too, and it
   should move deliberately.
3. There is no step three. Existing hashes keep verifying at their own
   parameters, and each is replaced the next time its owner signs in.

Lowering it is what the gate's rule R4 is about. `needsRehash` measures against
this same constant, so a weaker policy makes every stored hash read as current
and no test in this repository fails.

## Verify-then-rehash

A password hash cannot be upgraded in a migration. The stored value is a
one-way function of the plaintext, so raising the cost means re-deriving from
the plaintext — and the plaintext exists in this process for exactly one request
in an account's life: the one where somebody typed it. A background job has the
hash and nothing else, and can do no more with it than compare.

So the upgrade runs in the credentials provider's `authorize`, after
`verifyPassword` has returned true, and it is awaited. A floating promise is
cancelled with the request on a serverless runtime, so the two spellings differ
only in production.

Three properties are worth stating outright.

**The write is a compare-and-set.** `UPDATE users SET password = :new WHERE id
= :id AND password = :verified`, expressed as Prisma's `updateMany` because
`update` throws `P2025` when its unique predicate matches nothing and the
ordinary case of losing a race should not be an exception. Two concurrent
sign-ins racing each other is harmless — both derive a valid hash of the same
password. The case that is not harmless is a password _change_ landing between
the verification and this write: overwriting it would silently revert the
change, leaving someone with a password they believe they have replaced. Naming
the hash this call verified against makes that a no-op.

**The write goes through `unscopedPrisma`.** A password belongs to a person and
not to one of their workspaces, and `users` carries no tenant column and no
row-level policy — so the rehash writes the same table, through the same
client, that registration writes the first hash through. The import is where
that is visible, which is the point of the three access worlds in
`docs/multi-tenancy.md`; the entry in `UNSCOPED_READERS` carries the reason.

**Nothing here can fail a sign-in.** The password was already checked. A
database error means the hash stayed at its old cost, which is where it was a
moment ago; the inverse policy would turn a transient write failure into an
outage of the login page.

**The event carries the error's name, never its message.** Database drivers put
the failing statement's bound parameters into what they throw, and on this call
path those parameters are a freshly derived password hash. Redacting log output
in general is its own spec item; this module does not need it, because it never
has anything to redact.

## Reading a stored hash is parsing an input

A stored hash is one this application wrote, but "the only writer is us" is the
assumption every deserialisation bug is built on, and the cost of being wrong is
specific: the parameters in the string are an allocation size and a loop count,
read inside an unauthenticated POST. A row reading `ln=30` is a request to
allocate 137 GiB.

So `parsePasswordHash` bounds them. The ceiling is on the product — 256 MiB of
working set — rather than on `ln` alone, because `r` multiplies it just as
directly and bounding the two separately still permits their product. `p` has
its own bound because it costs time without costing memory, which is the one
dimension the product does not constrain. Anything outside those is `false`
from `verifyPassword`, not a throw: the caller is a sign-in path, and a corrupt
row should fail one login rather than the request.

The base64 fields are re-encoded and compared rather than merely decoded.
`Buffer.from(s, "base64")` skips characters outside the alphabet and truncates
on a partial group, so without the round-trip `salt!!` decodes to `salt` and
verifies.

## Legacy hashes

`hex.salt` strings still verify, at the Node defaults that produced them, and
`needsRehash` always reports them as behind. One detail decides whether that
works: the old code passed the salt to `scrypt` as a hex _string_, so the bytes
hashed are that string's own and not the ones it spells. Decoding it would fail
every legacy verification, quietly, for exactly as long as nobody had an old row
to test against.

That is why `scripts/assert-password-hashing.ts` reproduces the old
implementation and probes it on every build rather than trusting a fixture.

## The gate

`scripts/assert-password-hashing.ts` runs in CI. Four static rules and four
probes, each checked against the regression it names by breaking a copy of the
tree in `scripts/assert-password-hashing.test.ts`:

| rule | what it holds                                                          |
| ---- | ---------------------------------------------------------------------- |
| R1   | sign-in awaits `upgradePasswordHash`, after the verification           |
| R2   | nothing but `@/lib/password` derives a password                        |
| R3   | nothing but `PASSWORD_WRITERS` writes a `password` field               |
| R4   | `PASSWORD_HASH_POLICY` is at or above `POLICY_FLOOR`                   |
| P1   | a hash at policy round-trips, reads as current, and is in format       |
| P2   | a hash from the previous implementation verifies and reports as behind |
| P3   | one step above policy hashes and verifies — the cost is raisable       |
| P4   | a hash demanding 64 GiB is refused rather than allocated               |

The probes import the module from the root they are given, so the sabotage
cases in the test file break a copy and watch them fire. Every one of these
leaves a working application when it is lost, which is the only reason the gate
exists: delete the upgrade call and sign-in still works, lower the policy and
the suite stays green, drop the legacy branch and nothing fails until the first
person with an old account tries to sign in.

## Not done

- Sign-in is still the only path that _raises_ an existing hash's cost, so an
  account that never signs in never upgrades. `changePasswordAction` is now the
  fourth entry in `PASSWORD_WRITERS` and always writes at the current policy —
  but it needs the plaintext too, so it upgrades the accounts of people who
  choose to use it rather than the ones that have gone quiet. That is not a
  migration, and there is no such thing: the stored value is a one-way function
  of a password nobody has. See [session-hardening.md](./session-hardening.md)
  for the revocation the change performs with the write.
- No minimum-strength or breach-corpus check on the password itself. The
  registration schema asks for eight characters and nothing more, which is a
  policy decision this boilerplate has not made.
- The upgrade adds one derivation to the first sign-in after a policy change,
  on top of the verification. At the current parameters that is roughly 830 ms
  for that one request, once per account.
