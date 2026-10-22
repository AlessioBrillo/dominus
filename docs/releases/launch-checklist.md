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
| external monitoring | `--paid` and `EXTERNAL_PROBE_URL` is unset (the app node's own monitor cannot report the app node's outage) |
| legal text | the published documents are more than a year old (warning) |
| proxy depth | `TRUST_PROXY_DEPTH` is unset behind a proxy (warning) |
| alerting | the Alertmanager webhook is still the placeholder (warning) |
| job notifications | the dead-letter webhook is unset (warning) |
| legal documents (live) | `GET /public/legal` does not answer 200 with the three documents |
| legal footer (live) | a public page does not carry the legal footer |
| data rights (live) | the export endpoint does not exist |

## The human steps, in order

### 0. The trademark sources answer

The trademark gate is the one feature the product cannot be without
(Principle 6), and it depends on two free public endpoints that are not
ours:

| Source | Endpoint | State on 2026-10-22 |
|---|---|---|
| USPTO (Elasticsearch) | `POST https://tmsearch.uspto.gov/tmsearch` | **`405 Method Not Allowed`**, answered by Amazon S3: the path now serves the static assets of the search site |
| USPTO (TSDR fallback) | `GET https://tsdr.uspto.gov/tsdr/tmsearch/data?searchType=basic&search=<term>` | **`429 Too Many Requests`** from the launch network |

Reproduce it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://tmsearch.uspto.gov/tmsearch \
  -H 'Content-Type: application/json' --data '{"query":{"bool":{"should":[{"match_phrase":{"WM":{"query":"nike"}}}],"minimum_should_match":1}},"size":5}'
# 405
```

Until a source answers, the gate reports **unverified** and the domain is
**not** recommended — the conservative behaviour, and the reason the CLI
prints `Recommended: NO (TM unverified)` instead of a `YES` it cannot
justify. The providers were changed to fail closed in v1.3.2 (ADR-0097):
before that, a `405` was read as "this mark does not exist" and the gate
cleared the domain on a request that never happened.

What closes it:

- migrate the provider to the current USPTO search endpoint (the search
  site at `https://tmsearch.uspto.gov/search/search-results` is a
  JavaScript application whose backend is the replacement), or
- configure the free EUIPO credentials (`EUIPO_CLIENT_ID`,
  `EUIPO_CLIENT_SECRET`), which give the gate a second, independent
  source, or
- both.

Verify it before the launch, with the gate and not with a document:

```bash
dominus score nike.com          # the verdict must be "clear" or "blocked", never "unverified"
```

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
cp terraform.tfvars.example terraform.tfvars
cp backend.hcl.example backend.hcl   # the remote state: a secret store
terraform init -backend-config=backend.hcl
terraform plan && terraform apply       # needs HCLOUD_TOKEN
```

- **The state is a secret store.** It holds the three database passwords,
  the B2 application key and the whole `app_env` map. It must not live on
  the machine that created it: the backend configuration points it at
  Backblaze B2 (S3-compatible), and `backend.hcl` is gitignored like
  `terraform.tfvars`. The rotation runbook is in
  [operations/secrets.md](../operations/secrets.md).
- **SSH ingress is closed by default.** `ssh_allowed_cidrs` defaults to
  empty and the apply is refused until the operator either lists their own
  CIDRs or sets the explicit `allow_public_ssh = true`. The deploy pipeline
  reaches the app node from GitHub runners with dynamic egress addresses,
  so the opt-in is the realistic choice today — the point is that it is
  written down instead of inherited.
- point the domain at the load balancer and confirm the TLS certificate;
- confirm `/api/v1/health` answers from outside;
- put a real webhook in `deploy/prometheus/alertmanager.yml` (or let the
  Terraform module substitute it) and receive a test alert;
- **configure the external availability probe**
  ([operations/external-monitoring.md](../operations/external-monitoring.md)):
  Prometheus runs on the app node, so it cannot report the app node's own
  outage. The probe, the dead-man's switch and the `EXTERNAL_PROBE_URL`
  variable are specified in
  [`deploy/monitoring/uptime-probe.yml`](../../deploy/monitoring/uptime-probe.yml);
- run a **restore drill against the real backup target**
  (`scripts/restore-drill.mjs`), not against a local copy: the PITR path
  has never been executed against a real environment. The static
  `--pg-base` inspection proves the layout of a base backup and nothing
  else; the rehearsal is `--pg-restore`, which restores, replays the WAL,
  waits for the recovery to finish and compares row counts
  ([operations/rto-rpo.md](../operations/rto-rpo.md));
- roll a release through `deploy.yml` (migrate-before-roll, ADR-0061) and
  rehearse the rollback.

### 5. The Cloud acceptance suite

The Cloud topology has to run before it is deployed. The suite builds the
working tree's images, starts PostgreSQL with the production init script,
applies the migrations as the owner role, runs the api, the worker and
the scheduler against the non-superuser app role, and asserts the things
that only exist in the Cloud: tenant isolation at the API level and at
the database level, the Stripe webhook, the plan and usage surface, the
GDPR export and erasure, the metrics token, the scheduler → queue → worker
path, and the SPA against the same data.

```bash
npm run acceptance:cloud
```

It is a command, not a document: exit 0 means the assertions passed. The
scope and the boundaries are in
[cloud-acceptance.md](cloud-acceptance.md) — the boundaries are the work
list of the staging phase, not a disclaimer. It runs in CI on every pull
request, so a Cloud regression cannot reach `master`.

### 6. The third-party security audit

The decision on record is that the audit happens **before** the paid launch,
not after. The scope is the multi-tenant surface (RLS, `runWithTenant`,
pooled PostgreSQL), the OIDC session and CSRF, the public namespace, and the
Stripe webhook. The first-party review of the same surface is in
[audit-2026-08.md](../security/audit-2026-08.md): it is the starting point
for the auditor, not a substitute for it.

Put the report in `docs/security/` with a name that contains "external" or
"third-party": that is what the gate looks for.

### 7. The npm distribution

The community edition is distributed as `dominus-oss` on npm, published by
the release workflow through OIDC trusted publishing with a provenance
attestation. The publish of `v1.2.0` failed with `E404`, and the publish
of `v1.3.0` (20 October 2026) failed with the same error: the trusted
publisher is not configured on the npm account. The one-time setup is in
[npm-publishing.md](npm-publishing.md).

Until that is done, `npx dominus-oss` does not exist, and the README must
not claim otherwise. The GitHub Release and the container images are
published. The npm package is missing — and so is its provenance
attestation: npm attaches the attestation to the published tarball, so
there is nothing to verify while the package itself is absent. (The
container images carry their own BuildKit provenance, which is a different
mechanism and not a substitute.)

The publish is re-runnable. Once the trusted publisher is configured:

```bash
gh workflow run release.yml --ref v1.3.1
```

It rebuilds the same commit, updates the existing GitHub Release, and
publishes the package; the `verify` job then installs it from the registry
and runs it. The publish step skips the versions that are already on the
registry, so a re-run of an already published version updates the release
notes and still runs the verification instead of failing and skipping it.

The publish is now verified twice (ADR-0091):

- **before the tag**, by `npm run release:verify -- --pack` in the local
  gate: the tarball is installed in a throwaway directory and run, so an
  artifact that does not boot never reaches a tag;
- **after the publish**, by the `verify` job of the release workflow: the
  published package is installed from the registry, the CLI is run, and
  the provenance attestation is read. A failure there cannot un-publish the
  package — the response is `npm deprecate` and a patch release — but it
  turns a silent distribution failure into a red workflow.

The rehearsal of the publish itself is `gh workflow run release.yml -f
dry_run=true`, which exercises the OIDC exchange for real without
publishing.

### 8. The launch

- the announcement (Product Hunt, Hacker News, the domain investor
  communities) with the launch checklist as the source of truth;
- a support channel that a human answers (the SLA promises a response time
  only to Enterprise, by contract). The response times in `SUPPORT.md` are
  a commitment to a person, not to a queue: before a tier promises four
  business hours, somebody has to be able to answer within four business
  hours. GitHub Discussions is enabled for the community edition, and the
  support address is the operator's published contact address;
- the status page and the incident runbook
  ([incident-response.md](../operations/incident-response.md));
- the monitoring: Prometheus, Alertmanager, Grafana, and the restore drill
  on the calendar.

## The evidence

| Step | Evidence | Where |
|---|---|---|
| trademark sources | the verdict of `dominus score <domain>` is not "unverified" | the operations log |
| fiscal position | the tax registration and the accountant's advice | private; the conclusion in the ADR |
| operator identity | the gate passing | the output of `npm run launch:check` |
| Stripe | the three scenarios | the table in [billing-tax-verification.md](billing-tax-verification.md) |
| Cloud behaviour | the acceptance report | the output of `npm run acceptance:cloud` |
| infrastructure | the applied plan, the TLS certificate, the health check | the deployment |
| restore drill | the drill output | the operations log |
| audit | the report | `docs/security/` |
| npm | the published package and its provenance attestation | the release on npm |

## If something goes wrong

The rollback is the same path as the rollout, in reverse: the previous
image is deployed and the schema is left at the previous migration, because
migrations are additive and backward compatible by policy
([migration-policy.md](migration-policy.md)). The data is restored from the
backup if it is needed, and the restore drill is what makes that
plausible.
