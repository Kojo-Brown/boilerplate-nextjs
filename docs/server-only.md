# Server-only secrets

A secret in this application is readable from exactly one module,
`src/lib/env/server.ts`, and that module cannot be compiled into a browser
bundle. This document is what enforces that, what each layer catches, and the two
things none of them can.

## The shape of the problem

Next 16 decides what ships to a browser from the module graph, not from where a
file lives. A Server Component importing a helper that imports a module carrying
`"use client"` sends that module to the browser; nothing in the diff says so. The
same is true in reverse, and it is the dangerous direction: a client component
importing a helper that reads `DATABASE_URL` puts a secret-reading module in the
client graph, and the edit that does it changes no directive and mentions no
secret.

What stopped that being a leak, before this item, was an accident of how Next
substitutes environment variables. Only `NEXT_PUBLIC_*` names become literals in
a client bundle; every other name is simply absent. So the Zod schema would find
the secrets missing and throw `Invalid environment variables` — in the visitor's
browser, on render, after the bytes had shipped. Nothing leaked. Nothing was
checked either, and the difference between those two only holds while the schema
is the thing being reached.

## The three layers

| Layer                                       | Catches                                                                 | Misses                                      |
| ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| `import "server-only"`                      | any client-graph import of a marked module, at any depth, at build time | a `process.env` read, which imports nothing |
| `server-only/no-secret-env-access` (ESLint) | a raw read of a declared secret, while typing                           | anything an `eslint-disable` covers         |
| `scripts/assert-server-only.ts`             | all of the above, plus marker coverage and the list the other two read  | nothing the module graph does not say       |

### 1. The marker

`server-only` is a package with no exports. Its export map resolves to an empty
module under the `react-server` condition and to a module that throws otherwise,
and Next aliases it to one or the other according to which graph is being
compiled. So `import "server-only"` in a module that reaches a client bundle is a
build error.

Measured rather than assumed. A probe client component importing
`@/lib/env/server`, rendered from the nav so every route reaches it:

```
Error: Turbopack build failed with 2 errors:
'server-only' cannot be imported from a Client Component module
  #5 [Client Component Browser]:
    ./src/lib/env/server.ts
    ./src/components/__probe.tsx
    ./src/components/nav/nav-links.tsx
    ./src/components/nav/app-shell.tsx
```

The trace is good. The first line of the same output is not — Turbopack also
says _"This API is only available in Server Components in the App Router, but you
are using it in the Pages Router"_, in a repository that has no Pages Router.
Read past it.

The marked modules are the ones that hold key material or a connection to
something that does:

| Module                          | Why                                                            |
| ------------------------------- | -------------------------------------------------------------- |
| `src/lib/env/server.ts`         | every secret, validated once                                   |
| `src/lib/prisma.ts`             | a Postgres URL carries its password in the authority           |
| `src/auth.ts`                   | the OAuth client secret, the credentials verifier, the adapter |
| `src/lib/auth/deployment.ts`    | reads `AUTH_URL`, and writes it back                           |
| `src/lib/preview/token.ts`      | mints capabilities with the preview signing key                |
| `src/lib/webhooks/signature.ts` | holds the webhook signing key                                  |
| `src/lib/actions/origin.ts`     | the Server Action origin allow-list                            |

Marking more than the root is not redundancy. The build names the marked module
it found, so marking `@/lib/prisma` is the difference between an error about
Prisma and an error about an env module two imports below it.

### 2. The lint rule

`import "server-only"` cannot see the read that imports nothing:

```ts
const secret = process.env.NEXTAUTH_SECRET; // in a client component
```

There is no import to mark, so no layer above notices. In a browser that
expression is `undefined`, and the code carries on: an HMAC over a zero-length
key, a comparison against `undefined`, a `?? ""` that silently turns a check off.
On the server the same read is quieter but still wrong — it bypasses the schema,
so a missing value becomes `undefined` at the point of use instead of a refusal
to boot.

`src/auth.ts` had exactly that, and the gate found it:

```ts
clientSecret: process.env["GOOGLE_CLIENT_SECRET"] ?? "",
```

An OAuth client configured with an empty secret whenever the variable is absent.

The rule lives in `eslint-rules/server-only.mjs` and is registered for
`src/**/*.{ts,tsx}` only. `e2e/` signs a webhook with
`process.env["NEXTAUTH_SECRET"]` from outside the application, against a server
that is already built, and `scripts/` is build tooling: covering them would be
asking them to import a module marked `server-only`, which is the opposite of the
point.

Which names count as secrets is not a judgement the rule makes. It reads the
`SECRET_KEYS` array out of `src/lib/env/server.ts`, next to the schema that
declares them — `AWS_REGION` is server-side and public, `AWS_SECRET_ACCESS_KEY`
is neither, and `DATABASE_URL` is in the list because a Postgres URL carries its
password. If the array cannot be found the rule throws rather than passing
everything.

It does not flag a computed key (`process.env[name]`), and it does not flag a
`process` that is a local binding — but an imported `node:process` is the same
object under the same name, so that one is still flagged.

### 3. The gate

`scripts/assert-server-only.ts`, five rules, static analysis, no build output
needed:

- **R1** — the env module still carries the marker, and `SECRET_KEYS` still
  parses and still names keys the schema declares. Deleting one line removes
  every build-time guarantee below it and nothing else in the repository fails:
  the unit suite aliases the marker away (it has to), and a build with no client
  component importing the module is green either way.
- **R2** — no module in the client graph is marked. `next build` refuses this
  too; the gate is the same answer in under a second, and the one that still
  answers when a build is not what is being run.
- **R3** — every module that imports the server env is marked, or is somewhere
  Next only ever runs on the server: a `"use server"` module, a route handler, a
  page, a layout, the proxy. Without this the marker set covers only the modules
  someone remembered.
- **R4** — the lint rule's check again, where an `eslint-disable-next-line`
  cannot reach it.
- **R5** — `src/lib/env/client.ts` reaches nothing marked. It is unmarked _because_
  it is for the browser, and today no client component imports it — so a
  `./server` import added to it would break nothing until the first one does,
  and then it would break for whoever wrote that component.

## Why the environment is two modules

One module validating both halves cannot be marked, because `NEXT_PUBLIC_*` is
read in the browser; left unmarked it puts the name of every secret one import
away from a client component. So the split is by audience:

|                 | `@/lib/env/server`                                              | `@/lib/env/client`   |
| --------------- | --------------------------------------------------------------- | -------------------- |
| exports         | `serverEnv`, `SECRET_KEYS`                                      | `clientEnv`          |
| holds           | every secret and every server-side setting                      | `NEXT_PUBLIC_*` only |
| importable from | a Server Component, a Server Action, a route handler, the proxy | anywhere             |
| marked          | yes                                                             | no, deliberately     |

A Server Component that needs a public value imports `@/lib/env/client` — being
on the server does not make the server module the right one to read, and reaching
for it there is how a public value ends up behind a marker.

## The runners that have to opt out

The marker throws in any Node process that sets neither export condition, which
is every runner here except Next itself. Each opts out in one place, and each
opts out of the _marker_, not of the boundary — `scripts/assert-server-only.ts`
is what still checks it:

- **Vitest** — `vitest.config.ts` aliases `server-only` to the package's own
  `empty.js`, the same file the `react-server` condition would pick. Setting
  `resolve.conditions: ["react-server"]` instead would also hand every test
  React's server build, which has no `useState`; the DOM project renders
  components, so that trade is not available.
- **Playwright** — `e2e/tsconfig.json` maps the specifier the same way, and
  `playwright.config.ts` points at it. `revalidate-webhook.spec.ts` imports
  `@/lib/prisma` to seed a post and `@/lib/webhooks/signature` to sign the
  request.
- **The seed script** — `pnpm db:seed` runs `tsx --conditions=react-server`,
  which is the condition rather than a substitute for it. It imports
  `@/lib/prisma`, and CI runs it on every build.

The gate scripts themselves need nothing: they import only unmarked modules
(`@/lib/security/csp`, `@/lib/rate-limit/policy`, `@/lib/api/runtimes`), and a
gate that needed a secret would be a gate reading a secret.

## What none of this covers

- **A value copied into a client component's props.** `<Widget token={secret} />`
  from a Server Component is a serialised secret in the RSC payload, and every
  layer here is satisfied: the read happened on the server, in a marked module,
  through the schema. Nothing in this document looks at what crosses that
  boundary.
- **A value logged.** `console.error(serverEnv)` in a route handler puts every
  secret in a log aggregator. Redaction is not part of this item.
