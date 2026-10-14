# Publishing `dominus-oss` to npm

The release workflow uses **OIDC trusted publishing**: there is no
long-lived `NPM_TOKEN` secret in the repository. Instead, the workflow
requests a short-lived token from GitHub's OIDC provider, npm verifies it
against a trusted-publisher record configured on npmjs.com, and that token
is valid for one repository, one workflow file and a bounded time.

This page is the one-time setup. Do it before the first `v*` tag is pushed,
otherwise the publish step fails with a trusted-publisher error.

## 1. Confirm the name is claimable

`dominus` on npm is held by an unrelated package, and so is `dominus-cli`.
The CLI ships as `dominus-oss`:

```bash
npm view dominus-oss version   # E404 means it is free
```

## 2. Create/verify the npm account

Trusted publishing requires an npm account with **2FA enabled** (a
granular access token is not needed, and none should be created).

- Log in at <https://www.npmjs.com/>
- Account settings → Enable 2FA. Use a TOTP app; SMS 2FA does not satisfy
  the publisher-token requirements.

## 3. Add the trusted publisher

On npmjs.com, for the package `dominus-oss` (create the package by
publishing an empty/prerelease placeholder or by using the "new package"
flow, or skip to the next section if the package does not exist yet):

> Settings → Trusted Publisher → GitHub Actions

| Field | Value |
|-------|-------|
| Organization or user | `AlessioBrillo` |
| Repository | `dominus` |
| Workflow filename | `release.yml` |
| Environment | *(leave empty unless you add one to the workflow)* |

> The workflow filename must match exactly. The name without the
> `.github/workflows/` path. This is what binds the publish to that
> specific workflow: a tag pushed while `release.yml` has been renamed
> will not publish.

If the package does not exist yet, npm's UI for adding a trusted publisher
only appears on an existing package. In that case, do one manual first
publish to claim the name (with a 2FA-enabled account and an automation
token that you then delete), or run the release workflow with `dry_run`
enabled, which exercises everything except the actual `npm publish`.

## 4. Verify the contract end to end

The `dry_run` input on the release workflow exercises the whole path
except the final publish:

```bash
gh workflow run release.yml -f dry_run=true   # only on a tag or via dispatch
```

It builds the frontend and the backend, runs `check:pack`, extracts the
CHANGELOG section (failing loudly if it is missing), and runs
`npm publish --dry-run --provenance`. That last command performs the OIDC
exchange for real — so a successful dry run proves the trusted publisher
record is correct, without publishing anything.

## 5. What a consumer can verify

Because the package is published with `--provenance`, npm emits a Sigstore
attestation linking the tarball to this repository, this workflow and the
exact commit. Anyone can check it:

```bash
npm audit signatures
# or, for a specific package:
npm view dominus-oss@1.2.0 dist.attestations
```

For a project whose value proposition is a scoring engine that gates real
purchases, provenance is not a nice-to-have: it lets a user confirm that
the artifact they installed was built from the source they can read.
