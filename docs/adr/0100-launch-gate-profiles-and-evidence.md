# ADR-0100: The launch gate has profiles and produces evidence, and the rehearsal is a command

## Metadata

| Field          | Value                                                              |
| -------------- | ------------------------------------------------------------------ |
| **Status**     | Accepted                                                           |
| **Date**       | 2026-11-02                                                         |
| **Authors**    | Alessio Brillo                                                     |
| **Deciders**   | Alessio Brillo                                                     |
| **Supersedes** | —                                                                  |
| **Relates to** | ADR-0090, ADR-0091, ADR-0094, ADR-0095, ADR-0097, ADR-0099          |
| **Project**    | DOMINUS                                                            |

## Context

At v1.3.4 the code is complete and the remaining launch blockers are
execution: the infrastructure has never been provisioned, the operator
identity and the fiscal position are human tasks, and the third-party audit
has not started. The launch gate (`npm run launch:check`) reflects the
Cloud's promises and nothing else:

1. It demands `LEGAL_*`, `METRICS_TOKEN` and `BACKUP_DIR` even from a
   self-hosted community deployment, which publishes the AGPL and the
   self-hosted data flow and has no operator identity to declare. A
   community deployment therefore cannot be declared launchable without
   lying about who operates it.
2. It prints a verdict and forgets it. The launch checklist asks for
   evidence, and a terminal scrollback is not evidence: a release cannot
   attach what the gate saw, and a reviewer cannot compare two runs.
3. It judges the environment and, with `--url`, a handful of endpoints. It
   never checks the things that break silently in public: the canonical
   origin, TLS, HSTS/CSP, the parity between the HTML and the JSON of the
   same public page, the sitemap the robots.txt advertises, the live
   trademark canary.
4. It cannot be exercised before the infrastructure exists. The Cloud
   acceptance suite (`npm run acceptance:cloud`) builds the production
   topology, but it explicitly names what it does not prove — the real
   providers, the point-in-time recovery, Stripe Tax — and it never runs the
   launch gate against the stack it just built.

The result is the failure mode ADR-0090 and ADR-0097 named: a gate that
checks the repository against itself cannot see the world, and a claim that
no command reproduces is a document.

## Decision Drivers

1. **The community edition must have its own launch bar.** Its promises are
   different from the Cloud's, and a gate that cannot state them
   accurately cannot judge them.
2. **Evidence must be an artifact.** A release should carry the output of
   the gate that approved it, not a link to a CI log that expires.
3. **The launch sequence must be executable before the infrastructure
   exists.** The first `terraform apply` is not the place to discover a
   canonical URL bug or a missing CSP header.
4. **The paid launch is stricter, not different.** `--paid` must turn the
   operator's contracts (Stripe, backups, proxy depth, external probe,
   audit, alerting) from warnings into failures.
5. **No secrets in evidence.** The gate records "is set", never the value.

## Considered Options

### Option A: keep one Cloud-only gate and document the community case

**Advantages:** no code; the Cloud gate stays exactly as reviewed.

**Disadvantages:** a community deployment is forever "not launchable" by
the only command that says what launchable means, and the operator is
pushed to invent an identity or ignore the gate. Both are worse than a
profile.

### Option B: a second, separate community script

**Advantages:** each script is simple and reads like its edition.

**Disadvantages:** two gates drift. The checks that matter (public surface,
legal footer, canonical origin, trademark) are identical, and a fix applied
to one would have to be remembered in the other. ADR-0097's lesson is that
duplicated truth rots.

### Option C: one gate, two profiles, evidence, and a rehearsal (chosen)

1. **Profiles.** `--cloud` and `--community`, plus auto-detection from the
   same rule the server uses (`DATABASE_URL` or a non-`env` auth provider).
   `--paid` implies cloud and raises the operator contracts to failures.
2. **Evidence.** `--evidence <dir>` writes
   `launch-evidence-<version>-<sha>.json` and `.md`, on pass and on fail.
   The JSON carries the mode, the target, every check, its detail and its
   duration; the Markdown is the human-readable table a release attaches.
3. **New checks.** The canonical origin (configured and rendered), TLS and
   HSTS/CSP on HTTPS, HTTP→HTTPS, HTML/JSON parity for the same public
   page, robots → sitemap, public input validation, data-rights endpoints,
   and the live trademark canary (`nike` blocked, `vintagecoffee` clear,
   never unverified).
4. **The rehearsal.** `npm run launch:rehearse` builds the production-parity
   Cloud stack with the acceptance suite, runs the gate against it with a
   complete fixture environment while the stack is up, writes the evidence
   and tears the stack down. With `--url` it judges a real deployment and
   starts nothing. PITR is opt-in (`--with-pitr --pitr-base … --pitr-wal …
   --pitr-expect-rows <table>:<count>`), because it needs a real base
   backup, a WAL archive and a row count worth comparing; a missing
   prerequisite is a SKIP with the command to run, never a pass.
5. **The paid bar.** `--paid` fails on: a missing Stripe configuration for
   any reason, a missing backup directory or zero retention, an unset
   `TRUST_PROXY_DEPTH`, a placeholder Alertmanager webhook, a missing
   external probe, and a missing third-party audit on file.

**Advantages:** one gate, two honest profiles; the evidence is the release
artifact; the rehearsal can run today, without credentials or spend, and
the same command judges staging tomorrow.

**Disadvantages:** the gate grows and must itself be tested; the rehearsal
is minutes, not seconds, so it is a separate CI job rather than part of
`npm run gate`; a live canary makes it network-dependent (deliberately:
the trademark source is the one dependency the product cannot do without).

### Option D: skip the rehearsal and provision staging first

**Advantages:** the fastest path to a real URL.

**Disadvantages:** the first deploy carries every unknown at once, and
ADRs 0095 and 0099 both record that the defects which matter are the ones
only the real path finds. A rehearsal narrows the first staging run to the
things that genuinely need the infrastructure.

## Decision

**Option C.**

The gate keeps a single implementation, with:
`--cloud` (default when the environment says so), `--community`,
`--paid`, `--url`, `--evidence`, `--json`, `--skip-trademark` (debug only,
recorded in the evidence).

The rehearsal is `npm run launch:rehearse`. It is not part of `npm run gate`:
`gate` is seconds-to-minutes and must stay fast enough to run on every push.
The rehearsal runs as its own CI job, like `acceptance:cloud`.

## Consequences

### Positive

- A community deployment can be declared launchable by the same command
  that judges the Cloud, with the checks that actually apply to it.
- Every release can attach the evidence the gate produced, and two runs can
  be compared line by line.
- The canonical origin, TLS, CSP, HTML/JSON parity and the trademark canary
  stop being "looked at once by a human" and become checks.
- The first staging deployment starts with a stack that has already run the
  gate, so the remaining unknowns are the infrastructure's, not the code's.
- The `--paid` profile is the checklist's "before the paid tiers" made
  executable.

### Negative

- The gate is larger and needs its own tests.
- The rehearsal adds a CI job measured in minutes, and its trademark canary
  depends on a live third-party endpoint.
- Evidence files contain the deployment URL and the names of failing
  checks; they must be reviewed before publication, like any release
  artifact.

### Neutral

- No product feature changes. The scoring engine, the pipeline and the
  Cloud surface are untouched.
- The community edition still publishes the AGPL and the self-hosted data
  flow; the gate simply stops pretending it must publish an operator
  identity.

## Links

- [ADR-0090](0090-legal-surface-and-launch-gate.md) — the launch state is a
  command, not a document.
- [ADR-0091](0091-verified-published-artifact.md) — the artifact is verified,
  not assumed.
- [ADR-0094](0094-launch-posture-single-replica-external-probe.md) — the
  external probe and the paid posture.
- [ADR-0095](0095-cloud-acceptance-suite.md) — the acceptance suite and its
  stated boundaries.
- [ADR-0097](0097-cli-front-door-and-release-state.md) — the release state
  and the front door.
- [ADR-0099](0099-release-verified-against-the-world.md) — the release
  verified against the world.
