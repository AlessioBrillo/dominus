# ADR-0046: Immutable Image Supply Chain

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-08 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0031, ADR-0042 |
| **Project** | DOMINUS |

## Context

Every container image reference in the build and deployment files is a
supply-chain decision: floating tags (`:latest`, bare distro tags like
`node:22-alpine`, `postgres:16-alpine`) are retaggable by their publishers,
so a re-pull tomorrow silently ships different — possibly vulnerable —
content than the image validated today. That breaks three properties the
project already committed to:

1. **Reproducible rollouts** (ADR-0031): a deployment is only reproducible
   if the artifact it pulls is the artifact that was tested. A floating tag
   makes the rollout result a function of registry timing.
2. **CVE hygiene**: retagged bases are the standard vector for injecting
   known vulnerabilities into otherwise clean builds (`node:22-alpine` was
   re-tagged multiple times per month while the audit history was clean).
3. **Conservative operations**: the DNS consensus gate (ADR-0039, ADR-0042)
   is the availability chokepoint of the product; the recursor image that
   backs its second opinion must not drift under the operator.

A second, separate defect was found while enforcing this policy: the
consensus recursor referenced `nlnetlabs/unbound` — **an image that does not
exist on Docker Hub** (NLnet Labs publishes no official Unbound image, only
`nlnetlabs/pythonunbound`). The override could never be pulled; the leg it
was supposed to provide had silently never deployed. A format-only policy
cannot catch this class of failure — only an existence check against the
registry can.

## Decision

Adopt an **immutable image supply chain**, enforced by a static guard and
validated against the registry:

1. **Digest pinning everywhere.** Every external `FROM` in the `Dockerfile`
   (via a digest-pinned `ARG` default, `NODE_IMAGE`), every external
   `image:` reference in `docker-compose*.yml`, and every image reference in
   the Kubernetes manifests (`deploy/*.yaml`) must carry a `@sha256:<64-hex>`
   digest, a release tag (`vX.Y.Z`), a commit tag (`sha-<hex>`), or an
   environment/ARG indirection. Floating tags are rejected.
2. **No default that floats.** `DOMINUS_IMAGE_TAG` in the prod compose
   profile no longer defaults to `master`: compose interpolation fails fast
   (`${DOMINUS_IMAGE_TAG:?…}`) when the variable is unset. A deployment that
   forgets the pin does not silently deploy a drifting tag — it refuses to
   start.
3. **Runtime strip of the npm CLI.** The runtime stages of the Dockerfile
   remove `/usr/local/lib/node_modules/npm`, corepack, and their launcher
   binaries. The entrypoints and healthchecks are plain `node`; the bundled
   npm tree is pure attack surface and is eliminated from shipped images.
   Build stages keep npm (`npm ci`, `npm run build`).
4. **Static guard with enforced gates.** `scripts/check-image-pins.mjs`
   scans the Dockerfile, all compose files, and the k8s manifests. It runs
   in the pre-push hook, as `npm run check:image-pins`, and as a dedicated
   CI job on every PR.
5. **Registry existence check.** CI validates that every digest-pinned
   reference actually exists in its registry (`docker buildx imagetools
   inspect`). Format-pinning a nonexistent image is still a broken rollout —
   this closes that gap and is what caught the phantom `nlnetlabs/unbound`
   reference.
6. **The consensus recursor** is pinned to `mvance/unbound@sha256:…`
   (replacing the nonexistent `nlnetlabs/unbound` reference). This is the
   community-maintained image recommended by the Unbound project itself; it
   is amd64-only and that limitation is documented at the point of use.

### Options considered and rejected

- **Keep floating tags + periodic manual pinning** — rejected: the drift
  window between retag and re-pin is precisely where bad content lands;
  a guard that only complains occasionally is not a gate.
- **Pin by semver tag only (`node:22-alpine` → `node:22-alpine` tags) —
  rejected: semver tags on distro images are mutable by the publisher
  (they retag patch releases). Only digests are immutable for external
  images; release tags are acceptable for images the project itself
  publishes (GHCR), where the tag is created once per release.
- **Build a self-owned Unbound image (multi-arch)** — deferred to a
  follow-up: it adds a build target and a publish pipeline to the deploy
  workflow. The pinned community image fixes the live defect now; owning
  the recursor image is a candidate ADR-0047.

## Consequences

### Positive

- Rollouts become reproducible: the digest in the manifest is the content
  that runs, and `imagePullPolicy: IfNotPresent` for immutable refs avoids
  registry round-trips per pod start.
- The phantom-image bug class (valid-looking reference, nonexistent image)
  is caught in CI before merge instead of at `docker compose up` on the
  production host.
- Shipped images drop the bundled npm CVE surface class.
- A missing `DOMINUS_IMAGE_TAG` fails fast with a clear compose error
  instead of deploying `master`.

### Negative

- Digest bumps are deliberate, documented events (the `Dockerfile` comment
  records the `docker buildx imagetools inspect` command used to obtain
  them).
- Compose and k8s deployments must now pass an explicit tag or digest; the
  documented quick-start commands carry `DOMINUS_IMAGE_TAG=…` explicitly.
- The recursor is pinned amd64-only; arm64 hosts cannot run the consensus
  override until the follow-up self-built multi-arch image lands.

### Risks and mitigation

- **Stale digests**: an old digest keeps pulling old content forever. The
  release process owns bumping digests; the CI existence check fails fast
  if a digest is ever revoked by its registry.
- **Digest for the wrong architecture**: pinning a single-manifest image
  on a different-arch host fails at pull. The recursor limitation is
  documented; the app's own images are multi-arch manifest lists.

### Related ADRs

- ADR-0031 (production hardening — reproducibility)
- ADR-0042 (private recursor — the image whose reference this policy fixed)
