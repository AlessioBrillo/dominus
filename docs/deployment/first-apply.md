# First apply — from zero to a staging Cloud

This runbook turns an empty Hetzner project into a staging DOMINUS Cloud
that the launch gate can judge. It is the execution half of
[launch-checklist.md](../releases/launch-checklist.md); the code half is
already in the repository.

**Status: written on 2026-11-02, never executed.** No credential, domain or
account existed when it was written. That is stated here on purpose: a
runbook that has never been run is a hypothesis with good formatting, and
the first person to follow it is expected to correct it. The local
rehearsal (`npm run launch:rehearse`) covers the application topology; it
does not cover Hetzner, DNS, Let's Encrypt, Backblaze B2 or the real
providers.

The staging environment is a **second Hetzner project**, never the
production one: its own state, domain, B2 bucket and secrets. A rehearsal
that shares a bucket with production can delete production's backups.

---

## 0. What you need before starting

| # | Account / asset | Why | Where it is used |
|---|---|---|---|
| 1 | Hetzner Cloud project `dominus-staging` | the two nodes | `hcloud_token` |
| 2 | An SSH key pair | operator access, no passwords | `ssh_public_key` |
| 3 | A domain you control, e.g. `staging.example.com` | TLS and canonical URLs | `domain` |
| 4 | Backblaze B2: bucket `dominus-tfstate` | remote Terraform state (it holds secrets) | `backend.hcl` |
| 5 | Backblaze B2: bucket `dominus-staging-pitr` | base backups + WAL archive | `b2_backup` |
| 6 | An alert webhook (Slack, Discord, ntfy, …) | Alertmanager and dead-letter jobs | `alertmanager_webhook_url`, `NOTIFIER_WEBHOOK_URL` |
| 7 | An external uptime monitor (UptimeRobot, Better Stack, Checkly, …) from a vendor **different** from the alert webhook | availability measured outside the app node | `EXTERNAL_PROBE_URL` |
| 8 | Stripe **test** account | the billing surface in staging | `STRIPE_*` |
| 9 | An OIDC provider test tenant (Auth0 free tier is enough) | the interactive login the acceptance suite cannot exercise | manual smoke |
| 10 | Optional: EUIPO API credentials | second trademark source | `EUIPO_CLIENT_ID` / `EUIPO_CLIENT_SECRET` |

Nothing in this list requires a paid plan except the two Hetzner nodes
(≈ €15/month) and, later, the domain. B2 and the uptime monitor have free
tiers that are sufficient for staging.

### 0.1 Hetzner

1. Create a project named `dominus-staging`.
2. Security → API tokens → **Generate token**, read/write, scoped to that
   project. Copy it once; it is not shown again.
3. Security → SSH keys → add the **public** half of your key.
4. Note the location you want (`fsn1`, `nbg1` or `hel1`).

### 0.2 Backblaze B2

Two buckets, two application keys, never the master key:

| Bucket | Contents | Key scope |
|---|---|---|
| `dominus-tfstate` | `dominus/terraform.tfstate` | read/write, this bucket only |
| `dominus-staging-pitr` | `base/` and `wal/` | read/write, this bucket only |

Create each key under **Application Keys → Add a New Application Key**,
restricted to its bucket. Note the `keyID` and the `applicationKey`; the
second is shown once.

### 0.3 The domain

The Terraform module can create the A record in Hetzner DNS when
`hetzner_dns_token` and `dns_zone_name` are set. If the domain lives at
another registrar, leave both empty and create the A record yourself after
`terraform apply` prints `app_public_ip`.

Caddy obtains the Let's Encrypt certificate on the first HTTPS request.
Ports 80 and 443 must reach the app node from the internet; the Terraform
firewall already admits them.

---

## 1. Rehearse locally first

The application topology can be proven before any account exists:

```bash
git clone https://github.com/alessiobrillo/dominus.git
cd dominus
git switch v1.4.0          # the release being deployed
npm ci
npm run launch:rehearse    # Docker required; builds the Cloud stack,
                           # runs the gate against it, writes evidence
```

A green rehearsal means the images, the migrations, the RLS policies, the
public surface and the gate agree. A red one is cheaper to fix here than
on a node you are paying for. The evidence lands in
`.acceptance/launch/` (git-ignored) and is described in
[evidence-index.md](../security/evidence-index.md).

The local gate, without Docker:

```bash
npm run gate
npm run launch:check -- --community --evidence .acceptance/launch
```

---

## 2. Prepare the state backend

The state is not a cache. It carries the rendered cloud-init, and
therefore the three database passwords, the B2 key and the whole
`app_env` map, in plaintext. It must not live on a laptop.

```bash
cd deploy/terraform
cp backend.hcl.example backend.hcl
```

Edit `backend.hcl`:

```hcl
bucket = "dominus-tfstate"
key    = "dominus-staging/terraform.tfstate"
region = "us-east-005"                          # the B2 region of the bucket
endpoint = "https://s3.us-east-005.backblazeb2.com"

skip_credentials_validation = true
skip_region_validation      = true
use_path_style              = true
```

Export the state bucket's key in the shell, not in the file:

```bash
export AWS_ACCESS_KEY_ID="<tfstate keyID>"
export AWS_SECRET_ACCESS_KEY="<tfstate applicationKey>"
```

`backend.hcl` must be git-ignored. The directory's `.gitignore` covers
`terraform.tfvars` and the state files; add `backend.hcl` before creating
it:

```bash
grep -qxF 'backend.hcl' .gitignore || echo 'backend.hcl' >> .gitignore
```

Then:

```bash
terraform init -backend-config=backend.hcl
```

Terraform asks no questions if the backend is correct. If it offers to
copy a local state, stop: you are initialising in the wrong directory or
with the wrong backend.

---

## 3. Write `terraform.tfvars`

```bash
cp terraform.tfvars.example terraform.tfvars
```

Generate the three database passwords; never reuse one:

```bash
openssl rand -base64 32   # db_password
openssl rand -base64 32   # db_backup_password
openssl rand -base64 32   # db_app_password
openssl rand -hex 32      # METRICS_TOKEN
```

A complete staging file:

```hcl
hcloud_token   = "<the dominus-staging token>"
ssh_public_key = "ssh-ed25519 AAAA... operator@laptop"
domain         = "staging.example.com"
location       = "fsn1"
image_tag      = "v1.4.0"       # must name a RELEASED tag

# The db node is operator-only and can be restricted freely.
# The app node is reached by the rollout script from the operator host
# egress; until a static-egress runner exists, the explicit opt-in is the
# honest choice. See deploy/terraform/README.md § SSH ingress.
ssh_allowed_cidrs = ["<your public IP>/32"]
allow_public_ssh  = true

db_password        = "<generated>"
db_backup_password = "<generated>"
db_app_password    = "<generated>"

alertmanager_webhook_url = "https://hooks.slack.com/services/..."

app_env = {
  # Identity: mark this as staging, never as the production operator.
  LEGAL_ENTITY_NAME         = "DOMINUS Staging (not a service)"
  LEGAL_ENTITY_KIND         = "individual"
  LEGAL_REGISTERED_ADDRESS  = "Staging environment — no offer to the public"
  LEGAL_VAT_ID              = "IT00000000000"
  LEGAL_CONTACT_EMAIL       = "staging@example.com"
  LEGAL_PRIVACY_EMAIL       = "privacy@example.com"

  # The public origin: without it the SPA publishes canonicals that point
  # at dominus.app, and the launch gate fails a public deployment.
  PUBLIC_APP_URL     = "https://staging.example.com"
  TRUST_PROXY_DEPTH  = "1"          # Caddy in front of the API
  ALLOWED_HOSTS      = "staging.example.com"

  # Cloud boot requirements.
  METRICS_TOKEN = "<generated>"

  # Monitoring: the same destination as Alertmanager, so one inbox.
  NOTIFIER_WEBHOOK_URL = "https://hooks.slack.com/services/..."
  EXTERNAL_PROBE_URL   = "https://staging.example.com/api/health"
  BACKUP_RETENTION_DAYS = "14"

  # Stripe TEST keys only. A live key in staging is a live key with a
  # staging blast radius.
  STRIPE_SECRET_KEY      = "sk_test_..."
  STRIPE_PUBLISHABLE_KEY = "pk_test_..."
  STRIPE_WEBHOOK_SECRET  = "whsec_..."
  STRIPE_PRICE_ID_PRO_MONTHLY  = "price_..."
  STRIPE_PRICE_ID_PRO_YEARLY   = "price_..."
  STRIPE_PRICE_ID_TEAM_MONTHLY = "price_..."
  STRIPE_PRICE_ID_TEAM_YEARLY  = "price_..."

  # AUTH_PROVIDER=db is the managed identity the Cloud uses; the OIDC
  # interactive login is a separate smoke (§8).
  AUTH_PROVIDER          = "db"
  AUTO_PROVISION_TENANTS = "true"
  USAGE_ENFORCEMENT_ENABLED = "true"

  # Optional second trademark source.
  # EUIPO_CLIENT_ID     = "..."
  # EUIPO_CLIENT_SECRET = "..."
}

b2_backup = {
  enabled         = true
  bucket          = "dominus-staging-pitr"
  account_id      = "<PITR keyID>"
  application_key = "<PITR applicationKey>"
  endpoint        = "https://s3.eu-central-003.backblazeb2.com"
}
```

Two things to check before planning:

- `image_tag` names a tag that exists on GHCR. A tag that was never
  released produces a first boot that pulls nothing.
- `PUBLIC_APP_URL` is the exact origin the browser will use, including
  `https://`. The gate compares it with the `--url` it is given.

---

## 4. Plan, then apply

```bash
terraform fmt -check
terraform validate
terraform plan -out=staging.tfplan
```

Read the plan. It creates two servers, a private network, two firewalls,
an SSH key, optionally the DNS record, and the B2-backed state. It does
not create the B2 buckets: those are the two manual steps in §0.2.

```bash
terraform apply staging.tfplan
```

Expected outputs:

```text
app_public_ip = "203.0.113.10"
db_private_ip = "10.0.0.2"
app_url       = "https://staging.example.com"
```

The apply is **refused** until the SSH posture is written down: either
`ssh_allowed_cidrs` is non-empty or `allow_public_ssh = true`. That is a
precondition in `deploy/terraform/main.tf`, not a warning.

If the apply fails halfway, the state is still the source of truth:
`terraform plan` again before retrying, and read the error rather than
deleting the state file. A state file deletion orphans paid servers.

---

## 5. DNS, TLS and the first health check

If `hetzner_dns_token` was set, the A record exists. Otherwise create it
at the registrar: `staging.example.com → app_public_ip`, TTL 60.

Wait for propagation, then:

```bash
curl -fsS https://staging.example.com/api/health
# {"status":"ok", ...}
```

The first request triggers the certificate. If it fails:

```bash
ssh root@<app_public_ip>
docker compose -f /opt/dominus/docker-compose.yml logs --tail=100 caddy
```

The usual causes are a DNS record that does not point at the node yet, or
port 80 blocked upstream. Do not disable HTTPS to "make it work": the
gate treats a plain-HTTP public deployment as a failure.

---

## 6. Bootstrap the first API key

The Cloud has no static `API_KEYS`; the first key is minted against the
database after the stack is up:

```bash
ssh root@<app_public_ip>
cd /opt/dominus
docker compose exec api node dist/cli.js keys create \
  --tenant staging-ops --name ops --role admin
```

The command prints the key once. Store it in the operator's secret store;
do not paste it into the shell history of a shared machine. Then:

```bash
curl -fsS -H "Authorization: Bearer <key>" \
  https://staging.example.com/api/v1/usage
```

A `401` means the key was copied wrong or the app is not connected to the
same database.

---

## 7. Run the launch gate against staging

The gate reads the **environment**, not the repository. Run it where the
deployment's environment is available, from a checkout of the same tag:

```bash
# On the operator workstation, outside the repository.
ssh root@<app_public_ip> 'cat /opt/dominus/.env' > ~/.dominus/staging.env
chmod 600 ~/.dominus/staging.env

cd dominus
git switch v1.4.0
node --env-file="$HOME/.dominus/staging.env" \
  scripts/launch-check.mjs --cloud \
  --url https://staging.example.com \
  --evidence .acceptance/staging
```

`--cloud` judges the managed edition. Do **not** pass `--paid` on staging:
`--paid` fails on a missing third-party audit, and the audit is a
production precondition. The staging run should be green with warnings;
the warnings are the staging work list.

Expected warnings at this point:

| Warning | Closed by |
|---|---|
| third-party audit not on file | the audit, before production |
| Alertmanager placeholder | a real webhook in §3, then re-run |
| external probe | §8 |
| canonical origin | `PUBLIC_APP_URL` in §3 |
| job notifications | `NOTIFIER_WEBHOOK_URL` in §3 |

If any of those is still a warning after the corresponding step, the step
did not reach the process: check `/opt/dominus/.env` on the node.

---

## 8. Close the staging-only gaps

Each of these produces an evidence artifact; the index is
[evidence-index.md](../security/evidence-index.md).

### 8.1 The external probe

Configure the probe with the contract in
[deploy/monitoring/uptime-probe.yml](../../deploy/monitoring/uptime-probe.yml):
`GET https://staging.example.com/api/health`, expect 200 and
`"status":"ok"`, every 60 s, from a region outside the app node. Configure
the dead-man's switch on a host that is not the app node. Point
`EXTERNAL_PROBE_URL` at the same URL and re-run the gate.

### 8.2 Alerting

Send a test alert through the real webhook:

```bash
curl -fsS -X POST https://hooks.slack.com/services/... \
  -H 'content-type: application/json' \
  -d '{"text":"DOMINUS staging alert test"}'
```

Then stop the API for two minutes and confirm the `ApiDown` alert
arrives. A webhook that accepts a `curl` is not the same as an
Alertmanager route that fires; this is the check that closes the
"monitoring does not alert anyone" blocker.

### 8.3 The restore drill (the real one)

The Cloud acceptance suite names PITR as out of scope: it needs a real
base backup and a WAL archive. The first staging drill is where the RTO
stops being a target.

The db node has `psql`, `pg_ctl`, `rclone` and the archive. Install Node
once and clone the same tag:

```bash
ssh root@<db_private_ip>    # via the app node or the private network
apt-get update && apt-get install -y nodejs npm git
git clone --depth 1 --branch v1.4.0 \
  https://github.com/alessiobrillo/dominus.git /opt/dominus/repo
cd /opt/dominus/repo && npm ci --omit=dev
```

Pull the newest base backup from B2 if it is not local:

```bash
rclone copy b2:dominus-staging-pitr/base/<base-dir> /var/backups/dominus/base/
```

Inspect the layout first, then restore:

```bash
node scripts/restore-drill.mjs --pg-base /var/backups/dominus/base/<base-dir>

node scripts/restore-drill.mjs --pg-restore \
  --base /var/backups/dominus/base/<base-dir> \
  --wal  /var/lib/postgresql/17/main/archive \
  --target-time "<UTC timestamp before the drill>" \
  --expect-rows schema_migrations:<n> \
  --expect-rows <a table you know>:<n>
```

Record: the command, the timestamp, the recovery duration, the row
counts, and the newest recoverable point. Those four numbers are the
evidence row in [rto-rpo.md](../operations/rto-rpo.md).

### 8.4 Stripe test mode

The three scenarios (IT B2C, IT B2B, DE B2B) are in
[billing-tax-verification.md](../releases/billing-tax-verification.md).
Record the outcome in its table; the table is the evidence, not a
screenshot of the dashboard.

### 8.5 The OIDC login

The acceptance suite runs `AUTH_PROVIDER=db`. Before production, one
manual smoke with the real provider: sign in, land on the dashboard,
confirm the tenant is the invited one, and confirm that a user without a
seat is refused. Record the timestamp and the outcome.

### 8.6 The real pipeline

Run one real scoring pipeline against the real providers and require a
**green** run, not a degraded one:

```bash
ssh root@<app_public_ip>
cd /opt/dominus
docker compose exec api node dist/cli.js run \
  --sync --closeout-csv examples/closeout-sample.csv
```

A degraded DNS stage means the resolver is not validating, and a
degraded run is a partial answer (ADR-0002). Record the run id.

---

## 9. Promote to production

Production is the same Terraform, a different project, domain and B2
bucket, plus the paid preconditions:

1. the fiscal position and the operator identity are real, not staging
   placeholders;
2. the third-party audit report is in `docs/security/` with "external" or
   "third-party" in the filename;
3. `EXTERNAL_PROBE_URL` and the Alertmanager webhook are real;
4. the Stripe **live** keys and price ids are configured, and the
   test-mode matrix has been repeated live;
5. `node --env-file=<production.env> scripts/launch-check.mjs --cloud \
   --url https://dominus.example --paid --evidence .acceptance/production`
   is green.

Then the release path is the documented one, not a manual compose edit.
GitHub Actions is a billing-blocked mirror, so the release is cut with the
local-first engine and rolled out with the shared rollout script:

```bash
git tag v1.5.1
git push origin v1.5.1
node scripts/release-cut.mjs --publish
# Then, on the target host (staging or production):
./scripts/deploy/rollout.sh --tag v1.5.1 --environment staging
```

The tag alone does not change what customers are served; the rollout does.
The rollback is the previous `DOMINUS_IMAGE_TAG` through the same pipeline,
with the migration gate refusing a downgrade across a schema change
([migration-policy.md](../releases/migration-policy.md)).

---

## 10. Evidence to keep

| Step | Artifact | Where |
|---|---|---|
| local rehearsal | `rehearsal-*.json` / `.md` | `.acceptance/launch/` |
| staging gate | `launch-evidence-*.json` / `.md` | `.acceptance/staging/` |
| acceptance | `report.json` | `.acceptance/` |
| restore drill | the command output and the four numbers | operations log |
| Stripe | the scenario table | [billing-tax-verification.md](../releases/billing-tax-verification.md) |
| OIDC smoke | timestamp and outcome | operations log |
| production gate | `launch-evidence-*.json` / `.md` | attached to the release |
| audit | the report | `docs/security/` |

The rule from [evidence-index.md](../security/evidence-index.md) applies
to all of them: an artifact without the command that produced it is a
screenshot, and a screenshot is not evidence.

---

## 11. What this runbook does not do

- It does not create the Hetzner, B2, domain, Stripe or OIDC accounts.
  Those are the operator's, by necessity: they are contracts, not
  configuration.
- It does not perform the fiscal registration, the legal review or the
  third-party audit.
- It does not promise a cost. The two nodes are the only fixed cost;
  egress, B2 storage and the domain depend on usage.
