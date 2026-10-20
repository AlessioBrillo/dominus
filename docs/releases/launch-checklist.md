# Launch checklist — DOMINUS Cloud

Two halves: the **mechanical gate** (`npm run launch:check`) and the
**human steps** that no script can do. The gate exists because a checklist
in a document is only as good as the reader's memory; the gate answers with
exit 0 or exit 1, and it can run in CI against a deployment.

```bash
# the environment and the repository
npm run launch:check

# a deployment, with the paid-launch preconditions
npm run launch:check -- --url https://dominus.example --paid
```

Run it where the environment is defined — on the app node, with the
deployment's environment loaded — because the checks that matter (the
identity, the metrics token, the backup configuration) read the
environment, not the repository. The `--url` probes then add what only a
live deployment can show: the published documents, the legal footer and the
data-rights endpoints.

## What the gate checks

| Check | Fails when |
|---|---|
| legal identity | any `LEGAL_*` field is missing or still a placeholder |
| metrics access control | `METRICS_TOKEN` is unset (the server refuses to boot without it in cloud mode) |
| backups | `BACKUP_DIR` is unset, or `BACKUP_RETENTION_DAYS` is zero |
| billing configuration | Stripe is configured but a published plan has no price id, or the webhook secret is missing |
| billing webhooks | `STRIPE_WEBHOOK_SECRET` is missing |
| security audit | `--paid` and no third-party review is on file |
| legal text | the published documents are more than a year old (warning) |
| proxy depth | `TRUST_PROXY_DEPTH` is unset behind a proxy (warning) |
| alerting | the Alertmanager webhook is still the placeholder (warning) |
| job notifications | the dead-letter webhook is unset (warning) |
| legal documents (live) | `GET /public/legal` does not answer 200 with the three documents |
| legal footer (live) | a public page does not carry the legal footer |
| data rights (live) | the export endpoint does not exist |

## The human steps, in order

### 1. The fiscal position

Selling subscriptions needs a tax position. This is an accountant's task and
it is the only step that cannot be automated or deferred:

- open a partita IVA (ditta individuale) or a company, and choose the tax
  regime (forfettario, ordinary);
- register for the **OSS** if B2C sales outside Italy will exceed €10,000 a
  year;
- agree the invoice series and the wording of the reverse-charge mention;
- have the data processing agreement (GDPR art. 28,
  [the template](../legal/data-processing-agreement.md)) reviewed with the
  accountant and the lawyer;
- have the legal texts reviewed. They were drafted without a formal review
  (ADR-0090) and that decision is recorded, not forgotten.

Until this is done the paid tiers stay switched off: the checkout fails
closed with `BILLING_NOT_CONFIGURED` until Stripe is configured, and Stripe
is not configured until there is something to invoice.

### 2. The operator identity

Set the `LEGAL_*` variables in the deployment
([the list](../legal/legal-surface.md)) and re-run the gate. The published
notice changes with the configuration; there is no rebuild.

### 3. Stripe

The dashboard settings only the operator can make are listed in
[billing-tax-verification.md](billing-tax-verification.md): tax
registrations, price tax behaviour (exclusive), the account's
terms-of-service URL (it must be the `/terms` page of the deployment), and
the invoice VAT ID.

Then run the three scenarios (IT B2C, IT B2B, DE B2B) in test mode, record
the evidence in the table of that document, and repeat them live.

### 4. The infrastructure

This work has never been done. It is the largest technical unknown:

```bash
cd deploy/terraform
terraform init && terraform plan && terraform apply   # needs HCLOUD_TOKEN
```

- point the domain at the load balancer and confirm the TLS certificate;
- confirm `/api/v1/health` answers from outside;
- put a real webhook in `deploy/prometheus/alertmanager.yml` (or let the
  Terraform module substitute it) and receive a test alert;
- run a **restore drill against the real backup target**
  (`scripts/restore-drill.mjs`), not against a local copy: the PITR path
  has never been executed against a real environment;
- roll a release through `deploy.yml` (migrate-before-roll, ADR-0061) and
  rehearse the rollback.

### 5. The third-party security audit

The decision on record is that the audit happens **before** the paid launch,
not after. The scope is the multi-tenant surface (RLS, `runWithTenant`,
pooled PostgreSQL), the OIDC session and CSRF, the public namespace, and the
Stripe webhook. The first-party review of the same surface is in
[audit-2026-08.md](../security/audit-2026-08.md): it is the starting point
for the auditor, not a substitute for it.

Put the report in `docs/security/` with a name that contains "external" or
"third-party": that is what the gate looks for.

### 6. The npm distribution

The community edition is distributed as `dominus-oss` on npm, published by
the release workflow through OIDC trusted publishing with a provenance
attestation. The `v1.2.0` publish failed with `E404` because the trusted
publisher is not configured on the npm account: the one-time setup is in
[npm-publishing.md](npm-publishing.md).

Until that is done, `npx dominus-oss` does not exist, and the README must
not claim otherwise.

### 7. The launch

- the announcement (Product Hunt, Hacker News, the domain investor
  communities) with the launch checklist as the source of truth;
- a support channel that a human answers (the SLA promises a response time
  only to Enterprise, by contract);
- the status page and the incident runbook
  ([incident-response.md](../operations/incident-response.md));
- the monitoring: Prometheus, Alertmanager, Grafana, and the restore drill
  on the calendar.

## The evidence

| Step | Evidence | Where |
|---|---|---|
| fiscal position | the tax registration and the accountant's advice | private; the conclusion in the ADR |
| operator identity | the gate passing | the output of `npm run launch:check` |
| Stripe | the three scenarios | the table in [billing-tax-verification.md](billing-tax-verification.md) |
| infrastructure | the applied plan, the TLS certificate, the health check | the deployment |
| restore drill | the drill output | the operations log |
| audit | the report | `docs/security/` |
| npm | the provenance attestation | the release on npm |

## If something goes wrong

The rollback is the same path as the rollout, in reverse: the previous
image is deployed and the schema is left at the previous migration, because
migrations are additive and backward compatible by policy
([migration-policy.md](migration-policy.md)). The data is restored from the
backup if it is needed, and the restore drill is what makes that
plausible.
