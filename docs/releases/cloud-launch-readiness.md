# Cloud launch readiness — status and blockers

This is the working document for the DOMINUS Cloud paid launch, not a
roadmap entry. It records what was verified, what is missing, and who
decides what. It is written to be read by someone joining the effort, so it
states facts with file paths rather than intentions.

Everything below was checked against the repository on 2026-10-14.

## What is solid

- 2,575 backend tests and 407 frontend tests green; 18 CI jobs including a
  PostgreSQL matrix, Docker smoke, OpenAPI contract coverage and a WCAG 2.1
  AA a11y gate.
- 83 accepted ADRs. The architecture record is genuinely current —
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

## Blockers, in the order they must be cleared

### 1. The community CLI was not installable — FIXED in this release

`package.json` was publish-shaped from the start (`bin.dominus`, `files[]`,
`prepublishOnly`) and CI validated the tarball with `check-pack`, but no
workflow published it and no documented command installed it. `npx dominus`
in the deployment matrix pointed at a package name held by an unrelated
project. The CLI now ships as `dominus-oss@latest` with an OIDC
trusted-publishing release and a `--provenance` attestation. See
[npm-publishing.md](npm-publishing.md).

> **Correction (2026-10-19):** the publish step of the `v1.2.0` release
> workflow failed with `npm error 404 Not Found — PUT
> https://registry.npmjs.org/dominus-oss`. The package is **not** on npm
> yet: the trusted publisher is not configured on the npm account for this
> repository. The workflow, the tarball and the provenance attestation are
> in place; the remaining step is the npm-side one-time setup described in
> [npm-publishing.md](npm-publishing.md).

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
| DPA / AVV (GDPR art. 28) | **MISSING** — still to be drafted with the accountant |
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

`src/services/billing-service.ts` enables Stripe Tax (`automatic_tax`) but
does not collect a tax ID, does not require a billing address and does not
update an existing customer: without those, an EU business customer cannot
apply the reverse charge and the tax calculation on a returning customer is
not reliable. The decision on record is **Stripe Tax**, which computes and
collects and is the lower-risk choice absent a dedicated accountant.

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

### 4. Monitoring does not alert anyone — MISSING

`deploy/prometheus/alertmanager.yml` ships with
`url: https://example.com/your-webhook`. The Terraform module substitutes a
real value; a compose-only production deployment alerts nowhere until an
operator edits it. `iac.yml` validates the Terraform substitution but
nothing validates the compose overlay.

A startup now warns when `TRUST_PROXY_DEPTH` is unset, which is the
misconfiguration that silently keys every per-IP rate limit on the proxy
instead of the client.

### 5. Scale — RECORDED, NOT CLOSED

The authenticated API rate limiter is in-process (`express-rate-limit` with
no store); Redis backs the public router only (ADR-0041/0052). Cloud mode
without Redis is already fatal in `composition-root.ts`, but **with** Redis
and more than one app replica the protected router still counts per
replica: the effective limit becomes `RATE_LIMIT_MAX × replicas`, and a
per-token counter resets when the balancer moves a caller. The single-node
Terraform module does not hit this. A multi-instance Cloud deployment needs
either a shared store on the protected router or a global throttle at the
proxy. This is a limiter change, not a config change.

## Decisions on record

| Topic | Decision |
|---|---|
| Write path for M3 (ADR-0083) | Same fail-closed consensus gate as the read path (ADR-0002), not write-then-compensate |
| Entità legale | EU (Italy); the legal notice follows art. 7 D.Lgs. 70/2003, not the German Impressum (ADR-0090) |
| VAT | Stripe Tax (`automatic_tax`), prices exclusive, VAT ID collected for the EU reverse charge (ADR-0090) |
| Tiers at launch | Free + Pro + Team; Enterprise on contract |
| Third-party security audit | Before the launch, not after |
| Legal texts | Drafted without a formal review; recorded as an accepted risk in ADR-0090 |
| Protected rate limiter | Single replica at launch; the shared store comes with the multi-replica topology |
| Version | v1.3.0 |

## Recommended sequence

The sequence is unchanged; what moved is how much of it is now done by
code instead of by hand. The full checklist, with the evidence to record,
is in [launch-checklist.md](launch-checklist.md), and the mechanical half of
it is `npm run launch:check`.

1. **Legal + VAT** — longest lead time, blocks revenue, can proceed in
   parallel with everything else. **Done in code** (ADR-0090): the legal
   notice, the terms of service and the privacy notice are server-owned
   data, published and linked from every public page, guarded by
   `npm run check:legal-placeholders`; Stripe Tax collects the address and
   the VAT ID and takes the withdrawal consent. **Left for a human**: the
   operator identity (`LEGAL_*`), the fiscal position, the review of the
   texts, and the three Stripe verification scenarios.
2. **Provision the infrastructure for real** — `terraform apply`, point DNS,
   confirm TLS and the health check, wire a real Alertmanager webhook, run
   an actual restore drill against real B2. This is the work that has never
   been done and is the largest technical unknown. **Unchanged: still
   undone.**
3. **Security audit** — external, scoped to the multi-tenant surface (RLS,
   `runWithTenant`, pooled PostgreSQL), the OIDC session and CSRF, the public
   namespace (`/public/*`, `AnonScoringService`, trademark budget), and the
   Stripe webhook. The first-party review of those four areas is in
   [audit-2026-08.md](../security/audit-2026-08.md). **Unchanged: still
   undone.**
4. **Remediate, then release the tiers.** The tiers stay behind the existing
   fail-closed billing gate until the operator has a fiscal position and the
   gate passes.

## What changed in v1.3.0

| Was | Now |
|---|---|
| Legal pages were React components with a German Impressum and a placeholder email | Server-owned structured data, published for the right jurisdiction, linked from every public page, guarded by the gate |
| No VAT ID could be collected, no address was required, the withdrawal right was never waived | Stripe Tax collects what it needs and the art. 59(1)(o) consent is taken at checkout |
| No way to export or erase a tenant's data | `GET /api/v1/tenant/export`, `DELETE /api/v1/tenant` and the `dominus tenant` commands |
| The launch state was a document | `npm run launch:check` answers with exit 0 or exit 1 |
| The E2E suite was not in the local gate, and master was red | The smoke gate is in `npm run gate`; master is green |

## What this document does not cover

- Product roadmap items (M3/M4/M5 of ADR-0083, real-time collaboration,
  mobile app). Those are in [ROADMAP.md](../../ROADMAP.md).
- The migration policy for schema changes, in
  [migration-policy.md](migration-policy.md).
