# ADR-0102: GitHub Release as the sole distribution channel

## Metadata

| Field          | Value                                                                 |
|----------------|-----------------------------------------------------------------------|
| **Status**     | Accepted                                                              |
| **Date**       | 2026-11-09                                                            |
| **Authors**    | Alessio Brillo                                                        |
| **Deciders**   | Alessio Brillo                                                        |
| **Supersedes** | ADR-0099 (npm as secondary channel), ADR-0101 (npm best-effort)       |
| **Relates to** | ADR-0091, ADR-0099, ADR-0101                                          |
| **Project**    | DOMINUS                                                               |

## Context

At v1.3.4 the GitHub Release became the primary distribution channel for
the community edition, with npm (`dominus-oss`) as a best-effort secondary
channel behind an OIDC trusted publisher. The npm trusted publisher was
never configured: every publish attempt (`v1.2.0`, `v1.3.0`, first
`v1.3.3`) failed with `E404`. npm view confirms the package does not
exist on the registry (E404).

A distribution channel that depends on an account setting nobody can
automate is not a channel — it is a latent failure. Two channels also
mean two artifacts to verify, two checksums to track, and two places
where a release can silently break. The GitHub Release is already
verified end-to-end by `release-cut.mjs`: tarball built once, checksum
attached, installers tested on Linux and Windows, public URL installed
and run after publish.

## Decision

The **GitHub Release is the sole distribution channel** for DOMINUS:

1. `dominus-oss` is **not published** to npm. `npm view dominus-oss`
   returns E404 and remains so.
2. The install channel is: `curl -fsSL .../install.sh | sh` (Linux/macOS)
   or `iwr -useb .../install.ps1 | iex` (Windows), plus the manual
   tarball + checksum path (`npm install -g ./dominus-oss.tgz`).
3. `scripts/release-cut.mjs` builds the tarball once and uses it for every
   artifact: versioned tarball, alias `dominus-oss.tgz`, both checksums,
   both installers.
4. `npm-publishing.md` is retained as historical context only; the trusted
   publisher setup it describes is not performed.
5. The README, launch checklist, and cloud launch readiness documents
   name the GitHub Release as the only channel and contain no `npx`
   or `npm install dominus-oss` instructions.

## Consequences

### Positive

- One artifact, one checksum, one channel to verify. A release either
  ships completely on the GitHub Release or not at all.
- No dependency on an npm account, 2FA, OIDC trusted publisher, or
  registry billing state.
- The release engine's existing end-to-end verification (installers
  against the public alias tarball, `check-published-install`) covers
  the entire distribution path.

### Negative / trade-offs

- `npx dominus-oss` does not exist. Users must use the installer or the
  manual tarball path. This is documented in the README.
- No provenance attestation on npm itself (there is no npm package). The
  attestation-equivalent is the GitHub Release asset chain plus the
  installer's sha256 verification.

### When npm returns

If the npm trusted publisher is configured in the future and the team
wants `dominus-oss` on the registry, a new ADR must revisit this
decision. Until then, npm is out of scope.
