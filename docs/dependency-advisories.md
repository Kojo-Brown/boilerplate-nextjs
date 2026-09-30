# Dependency advisories

There are two ways a dependency becomes a problem, and they need different
machinery.

The first is that it **changes**: a new version lands, and with it new code you
did not write. Dependabot covers that one. It opens a pull request per update,
CI runs against the change, and the failure — if there is one — is pointed
directly at the thing that moved. `.github/dependabot.yml` is that half, and
its comments explain the grouping.

The second is that it **does not change**. A version pinned months ago, resolved
once into `pnpm-lock.yaml` and never touched again, is exactly the one an
advisory is most likely to be published against, and it is the one no pull
request will ever mention. Nothing in this repository looked at it. That is what
`.github/workflows/dependency-audit.yml` is for.

## Why it is an issue and not a check

`pnpm audit` is deliberately **not** a pull-request gate, and it is worth being
precise about why, because "run the audit in CI" is the obvious answer and it is
the wrong one here.

An advisory is published by somebody else, against code somebody else wrote, at
a moment nobody in this repository chose. Wired to the pull-request check, that
means a typo fix in a README goes red on a Tuesday afternoon for a transitive
package it does not import and cannot upgrade — in a repository whose stated
rule, in `CLAUDE.md`, is that a red check is never merged. That rule does not
survive a fortnight of it. What replaces it is people merging red, and once that
is normal the rule protects nothing at all. The cost of the gate is not the
build minutes; it is the rule.

A scheduled job filing an issue decouples the two clocks. The advisory arrives on
the registry's schedule and is triaged on a person's. The pull request stays
about the change in it.

## Why it still fails

The distinction that matters is narrower than "never fail". The job must never
fail _a pull request_; it must always fail _itself_ when it could not do its
work.

This job's dangerous outcome is the quiet one. A registry outage, a `gh` that
cannot authenticate, an output format that changed under us — every one of them
produces no issue, and **no issue is exactly what a healthy dependency tree also
produces**. There is no way to tell the two apart from the outside, so the job
does not try: every error is thrown, the run goes red, and a red scheduled run
is visible on the Actions tab. The one outcome that is not an error is finding
advisories, which is the job working.

The same reasoning is why the audit runs with no `--audit-level` and no
`--ignore-registry-errors`. The first hides everything below a severity. The
second turns an outage into a clean bill of health, which is the single result
this design cannot tolerate. `scripts/assert-advisory-audit.ts` rule A6 fails
their reappearance, reading the argv the script actually executes rather than a
copy of it in a workflow file.

## What the issue says

One issue, identified by the `dependency-advisory` label rather than by its
title — the title carries counts, and the counts change whenever the tree does.

The body is split into **production graph** and **development-only**, which is
the triage decision and not a cosmetic one. `@faker-js/faker` shipping an `eval`
path matters to whoever runs the seed script; a path traversal in `next` is the
deployment. A reader who cannot tell them apart at a glance triages neither.

That split cannot be derived from a single audit: `paths` records the resolution
chain (`.>next>postcss`) and says nothing about whether the root edge was a
`dependencies` entry. So the script runs `pnpm audit --json` and `pnpm audit
--prod --json`, and the second run's set is used **only** as a flag on the
first's. An advisory the production run reports and the full run does not would
mean the two disagree about the tree, which is a bug rather than a finding, so
the full run's set is the one that gets reported.

Anything muted by `pnpm.auditConfig` in `package.json` is printed under its own
heading. A mute is invisible in every other view of this repository, and the one
process that exists to notice advisories is the worst possible place for it to
stay invisible.

## How the issue is kept current

The body carries a fingerprint — `<!-- advisory-fingerprint: … -->` — over the
identifiers, severities, installed versions and production flags of the set. It
deliberately excludes the titles, the resolution paths and the date, because a
weekly run that rewrote the body every Monday would bury the one week the set
actually moved under fifty-one weeks of noise.

Three behaviours follow, and all three are in `plan()` rather than in the
workflow, because a reconciler that gets them wrong still looks like it works:

| State                                       | What happens                              |
| ------------------------------------------- | ----------------------------------------- |
| Advisories, no open issue                   | Open one.                                 |
| Advisories, open issue, same fingerprint    | **Nothing at all** — no edit, no comment. |
| Advisories, open issue, changed fingerprint | Rewrite the body, then comment the delta. |
| No advisories, open issue                   | Comment why, then close.                  |
| No advisories, no open issue                | Nothing.                                  |

The body is state; the comments are the delta. Editing an issue body notifies
nobody, so the comment is the only part of an update that reaches somebody who
is not already looking — and it is written after the body, because a
notification that arrives ahead of the state it describes sends its reader to a
stale table.

**Only open issues are considered.** A closed one is a decision somebody made.
If the advisory comes back, the correct response is a new issue with a new
notification, not the quiet resurrection of a thread that was marked done.

## What to do with the issue

Nothing about this is automatic, and it should not be. Triage is:

1. **Is it in the production graph?** The first table is what gets deployed.
2. **Is there a patched version?** If Dependabot can reach it, the fix is to
   merge that pull request; the issue closes itself on the next run.
3. **Is the vulnerable path one this application uses?** An advisory against a
   CLI's argument parser, in a package that only runs during a build, is not the
   same risk as one in the request path. Write the reasoning on the issue — it
   is the only place it will be looked for.
4. **If there is no fix**, say so on the issue and leave it open. An advisory
   with no patched version is exactly the thing that should stay visible.

Muting is available (`pnpm.auditConfig.ignoreGhsas`) and is the last resort. A
mute is silent, permanent until somebody deletes it, and applies to every future
advisory that happens to share an identifier. It is printed in the issue body so
that it is at least not silent _here_.

## What is not covered

- **Only what the registry knows.** `pnpm audit` asks npm's advisory database
  about the lockfile. A vulnerability nobody has published is not in the answer,
  and neither is a malicious package that has not been reported — the supply
  chain rules in `docs/owasp-top-10.md` (T4) and the digest pins in
  `scripts/assert-action-pins.ts` are what stand in for that.
- **Only JavaScript dependencies.** The base image in `Dockerfile`, the actions
  in `.github/workflows/`, and anything the deployment target installs are out
  of scope. The actions have Dependabot's `github-actions` ecosystem; the image
  has nothing yet.
- **Reachability is by dependency graph, not by call graph.** "Production" here
  means "resolves through a `dependencies` entry". It does not mean the
  vulnerable function is ever called, and the audit cannot tell you that.
- **The workflow cannot be tested before it is on the default branch.**
  Scheduled workflows and `workflow_dispatch` both read the file from the
  repository's default branch, so a change to this job is verified by its own
  first run after merge. What _is_ testable before then is everything in
  `scripts/audit-dependencies.ts` — run `pnpm exec tsx
scripts/audit-dependencies.ts --dry-run` to print the exact issue body this
  tree produces, without a token and without touching the tracker.
