# ADR-0101: The release channel is local-first; GitHub Actions is a mirror

## Metadata

| Field          | Value                                                             |
| -------------- | ----------------------------------------------------------------- |
| **Status**     | Accepted                                                          |
| **Date**       | 2026-11-07                                                        |
| **Authors**    | Alessio Brillo                                                    |
| **Deciders**   | Alessio Brillo                                                    |
| **Supersedes** | —                                                                 |
| **Relates to** | ADR-0091, ADR-0099                                                |
| **Project**    | DOMINUS                                                           |

## Context

Since v1.3.4 the GitHub Release is the primary distribution channel for
the community edition (`dominus-oss`), and npm is best-effort until the
trusted publisher is configured. The release workflow (`.github/workflows/release.yml`)
is the only publisher, and it runs on GitHub Actions.

Since 2026-11-05 GitHub Actions has not assigned runners to this
repository (all jobs fail in 3–8 seconds with `runner_id: 0`, no steps
executed). While Actions is down, no tag can be published, no artifact can
be verified, and the release state announced by `package.json` cannot be
made real. `npm run release:doctor --remote` fails until a tag exists on
the remote with the correct alias tarball.

This is a single point of failure: the project cannot release because an
external platform stops assigning runners, not because the code or the
gate is broken.

## Decision

The release engine moves from the workflow to the repository:

1. **`scripts/release-cut.mjs`** is the single implementation used to cut
   a release. It runs preflight (clean tree, `master`, no existing tag,
   CHANGELOG section, live trademark canary), builds the tarball **once**
   (`npm pack`), verifies it locally (`check-pack`, `verify-release`,
   `test-installers`), then tags, creates/updates the GitHub Release,
   uploads all six assets, verifies the public channel end-to-end
   (`check-published-install` against the release URL), runs `release:doctor
   --remote`, runs `npm run gate` on the final tree, and writes evidence.

2. **`scripts/release-artifacts.mjs`** holds the shared primitives so the
   local engine and the workflow can never diverge: version/tag resolution,
   CHANGELOG extraction, tarball+checksum+alias build, asset list, and
   preflight checks.

3. `package.json` gains `release:cut` and `release:verify:public`.

4. `release:doctor` already validates the remote state: tag present on
   `origin`, alias tarball downloadable, checksum matching, tarball
   carrying the announced version. It is the post-publish check.

5. `release.yml` remains the mirror: once Actions runners are healthy
   again, it calls the same local functions (or the same sequence) so the
   channel a stranger downloads is still verified. Until then it is
   disabled; the local engine is authoritative.

6. The tag is cut **only** when the gate is green and the public channel
   is verified. Fail-closed: any preflight failure aborts before anything
   is mutated on the remote.

## Consequences

### Positive

- A release can be cut and verified even when GitHub Actions is
  unavailable: the operator's machine with Docker, Node and `gh` is
  sufficient.
- Local and CI releases use the same code (`release-artifacts.mjs`), so
  they cannot diverge.
- The public channel is verified before the tag exists: `check-published-install`
  runs against the release URL after upload, so a broken artifact never
  reaches a tag.
- Evidence (`release-evidence-<version>-<commit>.json/.md`) is written
  for every release.

### Negative

- The operator must have `gh` authenticated and Docker available to run
  `release:cut --publish`; `npm run gate` is also required on the final
  tree.
- `release.yml` is disabled during the Actions outage; it must be
  re-enabled and verified to call the same functions once runners return.

## Related

- ADR-0091: the published artifact is verified, not assumed.
- ADR-0099: the GitHub Release is the primary channel; npm is best-effort.
- `docs/releases/soft-launch-community.md` — the community soft-launch runbook.
- `docs/releases/npm-publishing.md` — npm trusted publisher one-time setup.
