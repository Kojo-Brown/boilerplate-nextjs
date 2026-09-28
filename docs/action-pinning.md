# Action pinning

Every GitHub Action this repository runs is named by a commit digest, not a tag.

```
.github/workflows/ci.yml        → the workflow GitHub runs
workflow-templates/ci.yml       → shipped to be copied; Dependabot cannot see it
workflow-templates/deploy.yml   → same
.github/dependabot.yml          → the `github-actions` entry that moves the pins
scripts/assert-action-pins.ts   → fails CI if any of that stops being true
```

| Action                    | Digest                                     | Release  |
| ------------------------- | ------------------------------------------ | -------- |
| `actions/checkout`        | `11d5960a326750d5838078e36cf38b85af677262` | `v4.4.0` |
| `actions/setup-node`      | `49933ea5288caeca8642d1e84afbd3f7d6820020` | `v4.4.0` |
| `actions/cache`           | `0057852bfaa89a56745cba8c7296529d2fc39830` | `v4.3.0` |
| `actions/upload-artifact` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | `v4.6.2` |
| `actions/github-script`   | `f28e40c7f34bde8b3046d885e986cb6290c5673b` | `v7.1.0` |
| `pnpm/action-setup`       | `b906affcce14559ad1aafd4ab0e942779e9f58b1` | `v4.3.0` |

## Why a tag is not a version

A git tag is a mutable pointer. `actions/checkout@v4` does not name code; it
names a ref, and the ref is resolved by the runner at the moment the job starts.
Whoever can push to that repository can move it, and on the next push to `main`
here, the new code runs in a job that holds `GITHUB_TOKEN`, the CI database URLs
and a freshly minted auth secret.

This is the `tj-actions/changed-files` compromise of March 2025: no action was
released, no workflow was edited, and tens of thousands of repositories ran an
attacker's code, because the tags they had already reviewed were moved
underneath them. A digest is the one reference GitHub cannot re-point.

## What the version comment is for

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
```

The comment is load-bearing rather than decorative. Dependabot parses it to
decide what the digest currently means, and on an update rewrites the SHA and
the comment together — so the diff reads `v4.4.0 → v4.5.0` instead of forty hex
characters changing into forty others. Rule P2 fails a pin without one.

## The templates are the part nothing maintains

Dependabot's `github-actions` ecosystem reads `.github/workflows` and nothing
else. `workflow-templates/` is invisible to it, and it is also the directory
somebody copies into a new repository — so a stale pin there outlives this
repository. Rule P3 holds every file scanned to one digest per action: the
template cannot drift, because the update Dependabot makes to the workflow fails
CI until the template follows it.

## Updating a pin by hand

Dependabot does this weekly; the manual path is for a security update that
cannot wait.

```
git ls-remote --tags https://github.com/actions/checkout | grep 'refs/tags/v4'
```

Read the SHA next to the release you want, and **use the peeled one if there is
a `^{}` line for that tag.** An annotated tag's ref points at a tag object, not
at a commit, and `uses:` wants the commit. This is not a hypothetical either:
`pnpm/action-setup`'s `v4` is annotated, and peeling it is how the table above
came to say `v4.3.0`. The ref had been left behind while `v4.4.0` shipped, so
every run of this workflow had been on v4.3.0 for months while the file said
`v4` — which is the smaller version of the same problem digests solve. The pin
records what was actually running; moving it is now a reviewable line.

The gate cannot check that a digest exists on the action's own repository —
that needs the network, and a gate that fails when github.com is slow is a gate
people re-run rather than read. A wrong digest fails the workflow itself, on the
next run, with `Unable to resolve action`.
