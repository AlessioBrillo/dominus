# ADR-0091: The published artifact is verified, not assumed

## Metadata

| Field          | Value                                                     |
| -------------- | --------------------------------------------------------- |
| **Status**     | Accepted                                                  |
| **Date**       | 2026-10-20                                                |
| **Authors**    | Alessio Brillo                                            |
| **Deciders**   | Alessio Brillo                                            |
| **Supersedes** | —                                                         |
| **Relates to** | ADR-0046, ADR-0061, ADR-0090                              |
| **Project**    | DOMINUS                                                   |

## Context

The v1.2.0 release published nothing. The tag was pushed, the workflow ran,
the GitHub Release was created — and the npm step failed with `E404`, because
the trusted publisher was not configured on the npm account. The failure was
invisible for days: nobody read the workflow log, and the repository's own
`check-pack` gate was green the whole time, because the tarball built in the
workflow was complete and correct.

`check-pack` inspects the right artifact in the wrong place. It proves that
the package *this repository builds* is complete. It cannot see whether the
package *a consumer receives* exists, installs, boots, or reports the version
it claims. Between those two facts there is a registry, an account
configuration and a publish step — and every one of them has already failed
once in this project.

Two smaller defects sat in the same place:

1. **The dry run could not run.** The release workflow derived the version
   from `${GITHUB_REF#refs/tags/}`. On a branch that expansion does not
   match, so the version became the literal string `refs/heads/master` and
   the CHANGELOG lookup could never succeed. The instruction in
   `docs/releases/npm-publishing.md` — `gh workflow run release.yml -f
   dry_run=true` — was therefore guaranteed to fail, on a branch, before the
   first publish. The one rehearsal that could have caught the missing
   trusted publisher was broken in exactly the way that hid it.
2. **A tag could disagree with the package.** Nothing compared the tag with
   `package.json`, so a tag pushed against a stale tree would publish an
   artifact whose version did not match the tag that named it.

## Decision Drivers

1. **The failure mode is silence.** A missing artifact does not fail a
   user; it fails a user who was told to run `npx dominus-oss`. Only a gate
   that looks at the published package can catch it.
2. **The rehearsal has to be the rehearsal.** The documented dry run must
   exercise the OIDC exchange, because that exchange is what fails.
3. **The gate must not be able to publish.** Verification is a separate job
   from publication: a verification failure cannot un-publish, so it has to
   be loud and it has to be after the fact.
4. **The repository's release machinery must stay one thing.** The release
   workflow stays separate from the deployment workflow (different blast
   radius, different triggers).

## Considered Options

### Option A: Keep `check-pack` and read the workflow log

**Advantages:** no new code.

**Disadvantages:** the failure is discovered by a human reading a log, days
later — which is exactly what happened. A check that only runs on the
machine that built the artifact cannot see a distribution failure.

### Option B: Verify the tarball locally, before the publish

**Advantages:** catches a broken artifact before it is public; no registry
involved; fast and deterministic.

**Disadvantages:** it cannot catch the distribution failures — the missing
trusted publisher, the name not being claimed, the registry being
unreachable. Those are precisely the failures that happened.

### Option C: Verify the published package, after the publish

**Advantages:** it exercises the whole path a consumer takes — the registry,
the tarball, the install, the native bindings, the CLI, the database.

**Disadvantages:** a failure here is discovered after the artifact is
public. It cannot be undone; the response is `npm deprecate` and a patch
release.

### Option D: Both

## Decision

**Options B and C.**

- `scripts/verify-release.mjs` installs an artifact into a throwaway
  directory and runs it. It is the same script for both halves:
  - `--pack` packs the working tree and verifies that tarball. It is part
    of the local gate (`npm run gate`), so a tarball that does not install
    and boot never reaches a tag.
  - `--package <name>@<version>` installs from the registry and verifies
    the published artifact. It is a separate job in the release workflow,
    `needs: release`, running after the publish.
- What it proves: the package installs (native bindings included); the CLI
  entry point boots and reports the expected version; `dominus health`
  opens a fresh database, applies the migrations and reports a healthy
  system; the SPA and the manual-provider sample data are present; the
  published tarball carries a provenance attestation.
- The version is resolved explicitly in the workflow: from the tag on a tag
  push, from the `version` input (or `package.json`) on a manual dispatch.
  A tag that disagrees with `package.json` fails the workflow before
  anything is built.
- The registry is eventually consistent, so the verification retries: a
  package published a minute ago may not be visible yet, and "not visible
  yet" is not "not published".
- `SKIP_RELEASE_VERIFY=1` is the only escape hatch, it prints a warning,
  and it exists for machines without a network.

## Consequences

### Positive

- A missing or broken artifact is a red workflow, not a support ticket.
- The documented dry run works again, so the OIDC exchange is rehearsed
  before the first publish — the rehearsal that would have caught the
  v1.2.0 failure.
- A tag that disagrees with the package cannot be published.
- The verification is provider-neutral: it checks the artifact, not the
  registry's opinion of it.

### Negative

- The gate now needs the network: the artifact is installed from the
  registry. The escape hatch exists, and it is loud.
- The local gate pays for an install and a boot on every run.
- A verification failure after the publish cannot un-publish the package.
  The response is `npm deprecate` plus a patch release, and the workflow
  says so.

## Links

- `scripts/verify-release.mjs` — the verification.
- `.github/workflows/release.yml` — the version resolution and the
  verification job.
- `scripts/check-pack.mjs` — the static completeness check, unchanged.
- `docs/releases/npm-publishing.md` — the one-time npm setup.
