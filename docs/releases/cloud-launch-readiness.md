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

### 2. Legal documentation — MISSING, and it gates revenue

None of these exist anywhere in the repository:

| Document | Why it is required |
|---|---|
| Terms of Service | no contractual basis for the service |
| Privacy Policy / Datenschutzerklärung | GDPR art. 13–14 |
| Impressum | mandatory in DE/AT; the deployment is Hetzner, the audience is the EU |
| DPA / AVV (GDPR art. 28) | the app processes personal data (team invitation emails) |
| Cookie/consent notice | ePrivacy; tokens are held client-side |
| Right of withdrawal (14 days) | EU consumers, digital services |

`src/services/billing-service.ts` has **no tax handling at all**: no
`automatic_tax`, no `tax_id` collection, no `invoice_settings.tax_ids`.
Selling EU digital subscriptions without VAT at the customer's rate, or a
correct B2B reverse charge, means the VAT collected is owed back plus
penalties. The decision on record is **Stripe Tax (`automatic_tax`)**, which
computes and collects and is the lower-risk choice absent a dedicated
accountant.

There is also no `docs/README.md`-visible privacy contact for the SPA — the
frontend has no `/terms`, `/privacy` or `/imprint` routes at all.

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
| Entità legale | EU |
| VAT | Stripe Tax (`automatic_tax`) |
| Tiers at launch | Free + Pro + Team; Enterprise on contract |
| Third-party security audit | Before the launch, not after |
| Version | v1.2.0 |

## Recommended sequence

1. **Legal + VAT** — longest lead time, blocks revenue, can proceed in
   parallel with everything else. Draft ToS / Privacy / Impressum / DPA /
   cookie notice; configure Stripe Tax in test mode.
2. **Provision the infrastructure for real** — `terraform apply`, point DNS,
   confirm TLS and the health check, wire a real Alertmanager webhook, run
   an actual restore drill against real B2. This is the work that has never
   been done and is the largest technical unknown.
3. **Security audit** — external, scoped to the multi-tenant surface (RLS,
   `runWithTenant`, pooled PostgreSQL), the OIDC session and CSRF, the public
   namespace (`/public/*`, `AnonScoringService`, trademark budget), and the
   Stripe webhook. Prepare a self-review of those four areas before paying
   an auditor.
4. **Remediate, then release the tiers.**

## What this document does not cover

- Product roadmap items (M3/M4/M5 of ADR-0083, real-time collaboration,
  mobile app). Those are in [ROADMAP.md](../../ROADMAP.md).
- The migration policy for schema changes, in
  [migration-policy.md](migration-policy.md).
