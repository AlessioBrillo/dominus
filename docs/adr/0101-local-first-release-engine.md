# ADR-0101: Local-first release engine

## Metadata

| Field          | Value                                                                 |
|----------------|-----------------------------------------------------------------------|
| **Status**     | Accepted                                                              |
| **Date**       | 2026-11-08                                                            |
| **Authors**    | Alessio Brillo                                                        |
| **Deciders**   | Alessio Brillo                                                        |
| **Supersedes** | -                                                                     |
| **Relates to** | ADR-0091, ADR-0099, ADR-0100                                          |
| **Project**    | DOMINUS                                                               |

## Context

At v1.5.0 the release artifact is real, verified, and primary on GitHub
Release, but GitHub Actions cannot run releases: the account is locked
because of a billing issue, every Actions job fails before starting, and
`release.yml` is disabled manually. The local-first release engine
(`scripts/release-cut.mjs`) exists and works, but no ADR documents it, and
release documentation still describes Actions as the sole publisher.

A public repository whose CI badge is red and whose branch protection
requires 16 Actions checks that cannot execute is not credible: an
external contributor cannot open a mergable PR, and a reader cannot tell
which channel actually publishes the artifact.

## Decision

The release engine is **local-first and authoritative**:

1. `scripts/release-cut.mjs` is the single implementation used to cut a
   DOMINUS release. Local execution is authoritative; GitHub Actions is a
   billing-blocked mirror that is not part of the merge gate.
2. The tarball is built **once** and used for every channel (GitHub
   Release asset, alias tarball `dominus-oss.tgz`, checksums, installers).
3. Fail-closed: any preflight failure aborts before anything is mutated.
   Preflight includes: clean tree, on master, tag absent, CHANGELOG
   section for the version, trademark canary live against the real
   registers.
4. GitHub Release is the primary channel; npm (`dominus-oss`) is
   best-effort until an OIDC trusted publisher is configured. npm is not
   a precondition for launching the community edition.
5. The merge gate is the Woodpecker pipeline
   (`.woodpecker/ci.yml`), executed locally with `ci-local` or on a
   Woodpecker server. GitHub Actions workflows remain in the repository as
   documentation of the mirror; they are disabled on GitHub and not listed
   in branch protection.

## Consequences

### Positive

- A release can be cut and verified without a working Actions account.
- External contributors can open PRs and have them judged by a gate they
  can run locally (`ci-local`), without Actions minutes.
- The public README no longer shows red CI badges; the gate is described
  explicitly as Woodpecker + `ci-local`.

### Negative / trade-offs

- Until a Woodpecker server is registered and `woodpecker-cli setup` is
  run, the only authoritative execution is local (`ci-local`). This is
  documented, not hidden.
- The npm channel stays best-effort (no provenance attestation on npm
  itself) until the trusted publisher is configured. The documented
  install channel remains the GitHub Release tarball with checksum.

## When Actions returns

If the GitHub billing issue is resolved, `release.yml` can be re-enabled
and the 16 branch-protection checks restored. Until then they are removed
from protection and replaced with the Woodpecker context (`ci/woodpecker/pr/ci`)
when the server reports it, or with manual review plus a green `ci-local`
run noted on the PR.
