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
publishing an empty/prerelease placeholder — see the sequence below — or by
using the "new package" flow):

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

## 3a. The first publish: claim the name, then let OIDC do the rest

npm's UI for adding a trusted publisher only appears on an **existing**
package, so the name has to exist before the record can be configured. The
sequence that satisfies both constraints — the name is claimed, and the
release that users install still carries a provenance attestation — is:

```bash
# 1. Claim the name with a placeholder that is NOT the latest release.
#    A placeholder published from a laptop has no provenance: that is fine,
#    nobody installs it, and it must not sit on the `latest` dist-tag.
mkdir dominus-oss-placeholder && cd dominus-oss-placeholder
cat > package.json <<'JSON'
{
  "name": "dominus-oss",
  "version": "0.0.1",
  "description": "Placeholder that reserves the dominus-oss package name. The real releases are published by the DOMINUS release workflow.",
  "license": "AGPL-3.0-only",
  "repository": { "type": "git", "url": "git+https://github.com/AlessioBrillo/dominus.git" }
}
JSON
echo "# dominus-oss — placeholder\n\nThe real package is published by the DOMINUS release workflow (see https://github.com/AlessioBrillo/dominus). Install it with:\n\n    npx dominus-oss@latest score example.com\n" > README.md
npm publish --access public --tag placeholder
```

Then configure the trusted publisher (section 3) and delete the
one-shot token you used for the placeholder, if you used one.

```bash
# 2. The release workflow now publishes the real version, with provenance.
git tag v1.3.1 && git push origin v1.3.1
# or, for a version that was already tagged:
gh workflow run release.yml --ref v1.3.1
```

Why not publish the real version by hand as the first publish? Because a
manual publish carries no provenance attestation, and the whole point of
the OIDC path is that the artifact a user installs can be traced back to
this repository. The placeholder costs one version number and keeps the
attestation.

> The publish step in `release.yml` is idempotent: it checks whether the
> version is already on the registry and skips the publish if it is, so
> re-running the workflow for a published version updates the GitHub
> Release and still runs the `verify` job against the published artifact
> instead of failing with E403 and skipping the verification.

## 4. Verify the contract end to end

The `dry_run` input on the release workflow exercises the whole path
except the final publish:

```bash
gh workflow run release.yml -f dry_run=true
```

It builds the frontend and the backend, runs `check:pack`, extracts the
CHANGELOG section (failing loudly if it is missing), and runs
`npm publish --dry-run --provenance`. That last command performs the OIDC
exchange for real — so a successful dry run proves the trusted publisher
record is correct, without publishing anything.

> A dry run is meaningful only **after** the package exists and the
> trusted publisher is configured. Before that, the OIDC exchange has
> nothing to exchange against: the dry run is a rehearsal of the
> publish, not a way to create the package.

The version is resolved explicitly (ADR-0091): on a manual dispatch it
comes from the `version` input, or from `package.json` when the input is
empty, so the dry run rehearses the version that is about to be tagged. On
a tag push the version comes from the tag, and a tag that disagrees with
`package.json` fails the workflow before anything is built.

## 5. The publish is verified too

Publishing is not the end of the contract: the artifact has to be
installable and runnable by the person who installs it. After the publish,
the `verify` job of the workflow installs the published package from the
registry, runs the CLI, and reads the provenance attestation:

```bash
node scripts/verify-release.mjs --package dominus-oss@1.3.0
```

The same script runs before the tag, on the local gate, over the tarball
that is about to be published:

```bash
npm run release:verify -- --pack
```

A failure after the publish cannot un-publish the package. The response is
`npm deprecate dominus-oss@<version>` and a patch release; the point of the
job is that the failure is a red workflow instead of a support ticket days
later.

## 6. The second channel: the tarball on the GitHub Release

The npm registry is the *convenient* channel, not the only one. The
trusted publisher failed twice (v1.2.0 and v1.3.0, both `E404`: the
publisher is not configured on the npm account), and a distribution that
depends on an account setting nobody can automate is one click away from
being no distribution at all.

Since v1.3.2 the release workflow builds the tarball **once** and uses it
for both channels:

- the asset attached to the GitHub Release, with its SHA-256 checksum
  beside it;
- the package published to npm (`npm publish <tarball>`).

They are the same bytes, so the artifact a user verifies against the
checksum is the artifact npm serves.

```bash
# No registry, no clone: the verified tarball and its checksum
curl -LO https://github.com/AlessioBrillo/dominus/releases/latest/download/dominus-oss-1.3.2.tgz
curl -LO https://github.com/AlessioBrillo/dominus/releases/latest/download/dominus-oss-1.3.2.tgz.sha256
sha256sum -c dominus-oss-1.3.2.tgz.sha256
npm install -g ./dominus-oss-1.3.2.tgz
dominus score vintagecoffee.com
```

The tarball is the same artifact the local gate verifies before the tag
(`npm run release:verify -- --pack`) and the release workflow verifies
after the publish.

## 7. What a consumer can verify

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
