# Cloud launch readiness — status and blockers

This is the working document for the DOMINUS Cloud paid launch, not a
roadmap entry. It records what was verified, what is missing, and who
decides what. It is written to be read by someone joining the effort, so it
states facts with file paths rather than intentions.

Everything below was checked against the repository on 2026-10-28.

## What is solid

- 2,575 backend tests and 407 frontend tests green; 18 CI jobs including a
  PostgreSQL matrix, Docker smoke, OpenAPI contract coverage and a WCAG 2.1
  AA a11y gate.
- 90 accepted ADRs. The architecture record is genuinely current —
  `check-doc-drift` derives route/repository/handler/CLI counts from the
  source tree, so the documents cannot silently rot.
- Fail-closed posture on the parts that matter: DNS consensus (ADR-0039,
  0059, 0063), RDAP origin-overlap guard (ADR-0060), trademark gate with EUIPO
  truncation treated as unverified (ADR-0014), `AUTOMATION_DRY_RUN` and
  `AUTOMATION_ENABLED` both defaulting off (ADR-0083).
- Tenant isolation with RLS and a `dominus_app` role that is never the
  PostgreSQL owner, precisely so `FORCE ROW LEVEL SECURITY` cannot be
  bypassed.
- Release engineering: migrate-before-roll (ADR-0061), additive-migration
  gate, PITR backup with a restore drill script, rollback on health-poll
  failure.
- The published artifact is verified, not assumed (ADR-0091): the local gate
  installs and runs the tarball before a tag, and the release workflow
  installs and runs the published package after the publish.

## Blockers, in the order they must be cleared

### 1. The community CLI is installable — GitHub Release primary, npm best-effort

The community edition ships as a **GitHub Release**: a versioned tarball, a
stable alias (`dominus-oss.tgz`), both checksums, and one-command installers
for Linux/macOS and Windows. Since v1.3.4 the release workflow verifies that
channel end-to-end (ADR-0099): the assets must be attached, the alias
tarball must install from the public URL, and the first command must answer.
The installers themselves are tested in CI on both platforms before they
ship.

npm remains **best-effort**: `dominus-oss` is published with OIDC trusted
publishing and a provenance attestation when the npm-side trusted publisher
is configured. The publishes of `v1.2.0` and `v1.3.0` failed with
`E404` because it was not; the one-time setup is in
[npm-publishing.md](npm-publishing.md). The README names the GitHub Release
as the primary channel, so a missing npm version is a documented
best-effort gap, not a broken promise.

What the failed publishes taught: `check-pack` was green throughout, because
it inspects the tarball the workflow builds and cannot see the artifact a
consumer receives. The artifact is now verified before the tag and after the
publish, on both channels (ADR-0091, ADR-0099), and a distribution failure
is a red workflow instead of a discovery days later.

### 2. Legal documentation — SURFACE BUILT, IDENTITY MISSING

**Status (2026-10-19, ADR-0090):** the three documents exist and are served
to the public. They were written for the wrong jurisdiction, so they were
rewritten: the operator is an Italian economic operator, so the applicable
rule is art. 7 of D.Lgs. 70/2003, not the German Impressum.

| Document | State |
|---|---|
| Legal notice (art. 7 D.Lgs. 70/2003) | published at `/legal-notice`; **the operator identity is still a placeholder** |
| Terms of Service | published at `/terms`; withdrawal (art. 52/59 Consumer Code) and reverse charge included |
| Privacy Notice | published at `/privacy`; sub-processors, transfers and retention included |
| DPA / AVV (GDPR art. 28) | **template published, not executed** — `docs/legal/data-processing-agreement.md`; the operator's fields and the review with the accountant and the lawyer are still open |
| Cookie/consent notice | folded into the privacy notice: no third-party analytics, no tracking cookies, so no consent is required |

The documents are server-owned structured data (`src/services/legal-content.ts`),
served unauthenticated at `GET /public/legal`, rendered by the SPA and linked
from the footer of every server-rendered public page. `npm run
check:legal-placeholders` fails the gate when a placeholder reaches the
published text, when a required clause disappears, or when the public pages
stop carrying the footer.

**What is still missing:** the operator identity (`LEGAL_ENTITY_NAME`,
`LEGAL_REGISTERED_ADDRESS`, `LEGAL_VAT_ID`, `LEGAL_CONTACT_EMAIL`,
`LEGAL_PRIVACY_EMAIL`, and for a company `LEGAL_REA_NUMBER` and `LEGAL_PEC`).
Until those are set, the notice publishes a placeholder — which is why
`npm run launch:check` refuses to declare a deployment launchable while they
are missing.

The documents were drafted **without a formal legal review**, and that is a
recorded decision (ADR-0090), not an omission. A review remains open work.

`src/services/billing-service.ts` enables Stripe Tax (`automatic_tax`) and
collects the billing address, the VAT ID and the art. 59(1)(o) withdrawal
consent (ADR-0090, v1.3.0). The plan granted on a completed checkout is
derived from the **Stripe price id**, not from the session metadata
(ADR-0093): the price id is read from the event payload or from the session
retrieved with the line items expanded, and a price id that maps to no plan
grants nothing.

### 3. Infrastructure has never been provisioned — MISSING

`iac.yml` runs `terraform validate` but its `plan` job is a no-op without
`HCLOUD_TOKEN`, and every step of the `deploy` job in `deploy.yml` is
guarded by `if: env.DEPLOY_SSH_HOST != ''`. Neither has ever been observed
running. Concretely unverified:

- `terraform apply` producing a working two-node stack (app CX32, db CX22,
  private network, Caddy with Let's Encrypt).
- The PITR backup path against real Backblaze B2 (ADR-0054 describes it; a
  restore drill has never been executed against a real environment).
- The `migrate-before-roll` rollout against a live database.

Two properties of the deployment are now decided in the code and have to be
exercised by the first apply (ADR-0094):

- **The state is a secret store.** It holds the database passwords, the B2
  key and the whole `app_env` map. The remote backend (Backblaze B2,
  S3-compatible) is configured through `backend.hcl`, which is gitignored
  like `terraform.tfvars`; a state file on a laptop is a lost deployment
  and a leaked set of credentials.
- **SSH ingress is closed by default.** `ssh_allowed_cidrs` defaults to
  empty and the apply is refused until the operator lists their own CIDRs
  or sets the explicit `allow_public_ssh = true`. The deploy pipeline
  reaches the app node from GitHub runners with dynamic egress addresses,
  so the opt-in is the realistic choice today — what changes is that the
  decision is written down instead of inherited from a default.

### 4. Monitoring does not alert anyone — MISSING

`deploy/prometheus/alertmanager.yml` ships with
`url: https://example.com/your-webhook`. The Terraform module substitutes a
real value; a compose-only production deployment alerts nowhere until an
operator edits it. `iac.yml` validates the Terraform substitution but
nothing validates the compose overlay.

A startup now warns when `TRUST_PROXY_DEPTH` is unset, which is the
misconfiguration that silently keys every per-IP rate limit on the proxy
instead of the client.

There is a second, quieter gap: Prometheus, Alertmanager and Grafana run on
the app node, so the monitor that would report an app-node outage is down
in the same failure. The SLA measures availability with an external probe,
and that probe does not exist yet. The specification and the configuration
are in [operations/external-monitoring.md](../operations/external-monitoring.md)
and `deploy/monitoring/uptime-probe.yml`; the launch gate warns without
`EXTERNAL_PROBE_URL` and fails with `--paid`.

### 5. The restore drill proves the layout, not the data — CLOSED IN CODE, NOT YET RUN

`scripts/restore-drill.mjs --pg-base` checked that a `pg_basebackup`
directory has the expected files. That is a layout check: it never
restored, never replayed a WAL segment and never compared a row, so the
RTO in [operations/rto-rpo.md](../operations/rto-rpo.md) was a target and
not a measurement.

`scripts/restore-drill.mjs --pg-restore` is the rehearsal: it restores a
base backup, replays the archived WAL, waits for the recovery to finish
instead of assuming it did, proves it is talking to the restored instance
(the system identifier in the manifest) and compares row counts. It has
never run against a real PostgreSQL, which is exactly what the first
staging drill has to do.

### 6. Scale — RECORDED, NOT CLOSED

The authenticated API rate limiter is in-process (`express-rate-limit` with
no store); Redis backs the public router only (ADR-0041/0052). Cloud mode
without Redis is already fatal in `composition-root.ts`, but **with** Redis
and more than one app replica the protected router still counts per
replica: the effective limit becomes `RATE_LIMIT_MAX × replicas`, and a
per-token counter resets when the balancer moves a caller. The single-node
Terraform module does not hit this. A multi-instance Cloud deployment needs
either a shared store on the protected router or a global throttle at the
proxy. This is a limiter change, not a config change.

### 7. The trademark source answers — CLOSED IN CODE (v1.3.3), GATED (v1.3.4)

The gate is the one feature the product cannot be without (Principle 6),
and the one feature that depends on somebody else's free endpoint.

- The USPTO provider was migrated to the `prod-stage-v1-0-0` search
  endpoint in v1.3.3 (ADR-0098) and answers again: `nike` is blocked,
  `vintagecoffee` is clear.
- The fail-closed behaviour remains (ADR-0097): an unanswerable source is
  an error, the verdict is **unverified**, and an unverified domain is
  never recommended.
- Since v1.3.4 the live canary is a release gate (ADR-0099): the `release`
  job does not publish while `npm run check:trademarks` is red, and a daily
  schedule opens an issue when the endpoint drifts between releases.

**What remains:** the dependency itself. The endpoint is not ours and can
move again; the canary turns that into a blocked release or an issue
instead of a silent degradation. EUIPO credentials remain the way to add an
independent second source, and are optional.

## Decisions on record

| Topic | Decision |
|---|---|
| Write path for M3 (ADR-0083) | Same fail-closed consensus gate as the read path (ADR-0002), not write-then-compensate |
| Entità legale | EU (Italy); the legal notice follows art. 7 D.Lgs. 70/2003, not the German Impressum (ADR-0090) |
| VAT | Stripe Tax (`automatic_tax`), prices exclusive, VAT ID collected for the EU reverse charge (ADR-0090) |
| Tiers at launch | Free + Pro + Team; Enterprise on contract |
| Third-party security audit | Before the launch, not after |
| Legal texts | Drafted without a formal review; recorded as an accepted risk in ADR-0090 |
| Protected rate limiter | Single replica at launch; the shared store comes with the multi-replica topology (ADR-0094) |
| Availability | One replica, measured by an external probe outside the app node (ADR-0094) |
| Ingress | Closed by default; the operator writes the decision down at apply time (ADR-0094) |
| Plan granted on checkout | Derived from the Stripe price id, never from the session metadata (ADR-0093) |
| Release | The published artifact is installed and run before and after the publish (ADR-0091) |
| Version | v1.3.4 |

## Recommended sequence

The sequence is unchanged; what moved is how much of it is now done by
code instead of by hand. The full checklist, with the evidence to record,
is in [launch-checklist.md](launch-checklist.md), and the mechanical half of
it is `npm run launch:check`.

0. **Prove the Cloud topology runs** — `npm run acceptance:cloud`
   (ADR-0095). The suite builds the working tree's images, starts
   PostgreSQL with the production init script, applies the migrations as
   the owner role, runs the api/worker/scheduler against the
   non-superuser app role, and asserts tenant isolation at the API and at
   the database level, the Stripe webhook, the plan and usage surface, the
   GDPR export and erasure, the metrics token and the scheduler → queue →
   worker path. **It found five defects that would have reached the first
   paid deployment** (the CLI was dead in PostgreSQL mode, the worker and
   the scheduler images could not boot, the first API key could not be
   minted, the manual run of a scheduled job did not work, and the CLI
   never released its connections). The scope and the boundaries are in
   [cloud-acceptance.md](cloud-acceptance.md).
1. **Legal + VAT** — longest lead time, blocks revenue, can proceed in
   parallel with everything else. **Done in code** (ADR-0090): the legal
   notice, the terms of service and the privacy notice are server-owned
   data, published and linked from every public page, guarded by
   `npm run check:legal-placeholders`; Stripe Tax collects the address and
   the VAT ID and takes the withdrawal consent. **Left for a human**: the
   operator identity (`LEGAL_*`), the fiscal position, the review of the
   texts, and the three Stripe verification scenarios.
2. **Provision the infrastructure for real** — `terraform apply` with the
   remote state, point DNS, confirm TLS and the health check, wire a real
   Alertmanager webhook, configure the external probe, run an actual
   restore drill against real B2 with `--pg-restore`. This is the work that
   has never been done and is the largest technical unknown. **Partly done
   in code** (ADR-0094): the fail-closed ingress, the remote state and the
   real rehearsal are implemented; **the execution is still undone.** The
   deploy pipeline now has a `staging` target (an explicit dispatch) and a
   `production` target (a release tag, with an approval), each with its
   own secrets.
3. **Security audit** — external, scoped to the multi-tenant surface (RLS,
   `runWithTenant`, pooled PostgreSQL), the OIDC session and CSRF, the public
   namespace (`/public/*`, `AnonScoringService`, trademark budget), and the
   Stripe webhook. The first-party review of those four areas is in
   [audit-2026-08.md](../security/audit-2026-08.md), and the metadata-trust
   finding it recorded is closed (ADR-0093). **Unchanged: still undone.**
4. **Remediate, then release the tiers.** The tiers stay behind the existing
   fail-closed billing gate until the operator has a fiscal position and the
   gate passes.

## What changed in v1.3.4

| Was | Now |
|---|---|
| The README's first command answered **404** on all four release URLs: the installers and the alias tarball were merged after the `v1.3.3` tag and no release carried them | A release attaches the alias tarball, both checksums and both installers, and the workflow asserts it |
| `install.sh` / `install.ps1` ran `npm install --prefix` without `-g`: the command landed in `<prefix>/node_modules/.bin` while the script looked in `<prefix>/bin`, printed "not on PATH" and exited 0 | `npm install -g`: the command is where the script and the README say it is; a corrupted checksum is refused |
| The installers had no test at all | `npm run test:installers` runs the real installer against a local release channel, on Linux and Windows, and asserts a working `dominus score` |
| `check:published-install` pointed the CLI at port `0`, measured its time budget between two adjacent statements, and 404'd on a release tag URL | The fixture starts first, the budget measures the command, a tag URL resolves to the alias, and the verdict must be `clear` |
| The release workflow verified only npm — the channel that had never been published — and never the GitHub Release | `verify-github-release` installs the public alias tarball and runs the first command, even when npm fails |
| ADR-0098 said the canary "fails the release workflow"; no workflow ran it | `trademark-canary` blocks the `release` job, and a daily schedule opens an issue on drift (ADR-0099) |
| The README said `dominus-oss` "is also published to npm", which was false | The README names the GitHub Release as primary and npm as best-effort until the trusted publisher exists |

## What changed in v1.3.2

| Was | Now |
|---|---|
| The first command a stranger runs built the whole application: 12.4 s, a SQLite database next to the user, a job worker, 14.8 KB of JSON log on stdout | The decision profile: engine and trademark gate only, ~2.5 s, nothing written to the disk, the decision alone on stdout (ADR-0097) |
| A trademark source that answered `405` was read as "this mark does not exist", and the gate cleared the domain on it | The sources fail closed: an unanswerable source is an error, the verdict is unverified, and an unverified domain is never recommended (ADR-0097) |
| The repository announced `1.3.1` with no tag, no image and no package, and every gate was green | `npm run release:doctor` compares the announced version with the tags, the tree and (with `--remote`) the registries |
| The documented quickstart output was not the output the command produced | `npm run check:quickstart` runs the advertised command and compares the documented output with the real one |
| The npm registry was the only channel, and the trusted publisher had failed twice | The verified tarball and its checksum are attached to the GitHub Release |

## What changed in v1.3.1

| Was | Now |
|---|---|
| The Cloud topology had never run as a system | `npm run acceptance:cloud` (ADR-0095) — the production data topology, with the assertions that only it can produce |
| The CLI died in PostgreSQL mode: every command, including `dominus keys create` | The SQLite-only commands refuse at invocation; the rest of the CLI works in the Cloud |
| The worker and the scheduler images could not boot (`PORT=0`) | Both boot; the docker smoke asserts that they are running, not merely present |
| The first API key of a Cloud deployment could not be minted | `dominus keys create` reads the row back for the tenant it wrote it for |
| `dominus scheduler run <job>` answered "Unknown job" | The job catalogue is registered without arming the cron timers |
| A tag pushed to `master` deployed to the only host, with no approval | Two targets: `staging` (an explicit dispatch) and `production` (a tag, with an environment approval) |
| The repository could announce a version the deployment did not run | `npm run check:release-consistency` compares the README, the Terraform example, the docker smoke and the CHANGELOG with `package.json` |

## What changed in v1.3.0

| Was | Now |
|---|---|
| Legal pages were React components with a German Impressum and a placeholder email | Server-owned structured data, published for the right jurisdiction, linked from every public page, guarded by the gate |
| No VAT ID could be collected, no address was required, the withdrawal right was never waived | Stripe Tax collects what it needs and the art. 59(1)(o) consent is taken at checkout |
| No way to export or erase a tenant's data | `GET /api/v1/tenant/export`, `DELETE /api/v1/tenant` and the `dominus tenant` commands |
| The launch state was a document | `npm run launch:check` answers with exit 0 or exit 1 |
| The E2E suite was not in the local gate, and master was red | The smoke gate is in `npm run gate`; master is green |
| The plan granted on checkout was read from the session metadata | It is derived from the Stripe price id, and an unknown price id grants nothing (ADR-0093) |
| The release workflow could not be rehearsed from a branch | The version is resolved explicitly and the dry run works; the published artifact is installed and run (ADR-0091) |
| The restore drill checked the layout of a base backup | `--pg-restore` restores, replays the WAL, waits for the recovery and compares row counts (ADR-0094) |
| The availability figure had no instrument | An external probe outside the app node, with a dead-man's switch (ADR-0094) |
| SSH ingress was open to the internet by default | The apply is refused until the operator writes the decision down (ADR-0094) |
| The community first run waited 30 s for a resolver that is usually not there | Five seconds in the community edition, thirty in the cloud (ADR-0092) |

## What this document does not cover

- Product roadmap items (M3/M4/M5 of ADR-0083, real-time collaboration,
  mobile app). Those are in [ROADMAP.md](../../ROADMAP.md).
- The migration policy for schema changes, in
  [migration-policy.md](migration-policy.md).
