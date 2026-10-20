# The Cloud acceptance suite and the staging runbook

The community edition is verified by its own test suite and by the
Playwright suite on SQLite. The **Cloud** edition — PostgreSQL with
row-level security, Redis, three processes, tenants, billing, usage
metering, GDPR — had never been exercised as a running system before the
paid launch.

This page describes:

1. [the acceptance suite](#1-the-acceptance-suite) — what it proves, what
   it does not, how to run it;
2. [the staging runbook](#2-the-staging-runbook) — the steps that turn the
   suite's boundaries into evidence;
3. [the audit hand-off](#3-the-audit-hand-off) — what the external auditor
   receives.

The decision behind the suite is [ADR-0095](../adr/0095-cloud-acceptance-suite.md).

---

## 1. The acceptance suite

### Running it

```bash
npm run acceptance:cloud
```

It builds the working tree's images, starts the stack, applies the
migrations, runs the assertions, runs the browser smokes, writes the
report and tears the stack down. The report lands in
`.acceptance/report.json`; the fixtures (which hold live API keys for the
throwaway database) land in `.acceptance/fixtures.json` and are
git-ignored.

Useful switches:

| Variable                   | Effect                                              |
| -------------------------- | --------------------------------------------------- |
| `KEEP_ACCEPTANCE=1`        | leave the stack running after the run                |
| `ACCEPTANCE_SKIP_BUILD=1`  | reuse the images already built                      |
| `ACCEPTANCE_WITH_UI=0`     | skip the browser smokes (no Playwright needed)      |
| `ACCEPTANCE_PORT`          | the host port the API is published on (default 3210) |

Requirements: Docker, and the Playwright browser once per machine
(`npm run e2e:install`).

In CI the suite runs on every pull request (Linux) as its own job.

### The stack

`docker-compose.acceptance.yml`, plus the Unbound overlay:

| Service    | What it is                                                       |
| ---------- | ---------------------------------------------------------------- |
| `postgres` | PostgreSQL 16 with the production init script (the app role)     |
| `redis`    | the queue's coordination store                                    |
| `api`      | the API, connected as the **app role**, with the Cloud env       |
| `worker`   | the job worker                                                    |
| `scheduler`| the cron scheduler                                                |
| `unbound`  | the validating resolver (ADR-0075 made it mandatory)             |

The split that matters: the **migrations are applied by the owner
role** and the **application connects as the non-superuser app role**.
A superuser bypasses row-level security even with `FORCE ROW LEVEL
SECURITY`, so an acceptance run that connected as the owner would prove
nothing about isolation. This is the same split the production
deployment has.

### What it proves

29 assertions:

| Assertion                                                        | What it protects                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| the API is healthy                                                | the stack boots at all                                  |
| an operator can mint the first API key (no admin deadlock)       | the bootstrap of a Cloud deployment                     |
| the second tenant gets its own key                               | the second tenant                                       |
| a key authenticates through `/auth/login`, an invalid one does not | the identity path the SPA uses                          |
| each tenant lists only its own rows                               | tenant isolation at the API level                       |
| a write against another tenant's row is a 404                     | tenant isolation at the API level                       |
| the app role is neither a superuser nor `BYPASSRLS`              | the isolation model itself (ADR-0038)                   |
| the app role sees no row without a tenant context                | the RLS policy                                          |
| the app role sees exactly its own tenant's rows                  | the RLS policy                                          |
| the owner sees every row                                          | the rows really exist (the isolation is not a filter)   |
| the RLS policies are enabled *and* forced                        | the tables are protected from their own owner           |
| a signed Stripe webhook grants the plan                           | the entitlement path                                    |
| the replayed event changes nothing                                | the webhook idempotency                                 |
| a tampered signature is refused                                    | the webhook authentication                              |
| the usage surface reports the tenant plan                        | the meter reads the right subscription                  |
| the metrics endpoint refuses an anonymous caller                  | the scrape token (cloud mode requires it)               |
| the metrics endpoint accepts the scrape token                     | the scrape token                                        |
| the legal surface is served                                        | the public legal pages (ADR-0090)                       |
| a tenant can be created for the erasure test                      | the third tenant                                        |
| the export contains the tenant's data                              | GDPR art. 15                                            |
| the erasure removes it and touches nothing else                   | GDPR art. 17                                            |
| the erasure needs a matching confirmation                          | a deletion is never an accident                         |
| the scheduler enqueues a job the worker consumes                  | the scheduler → queue → worker path                     |
| the worker and the scheduler are alive                            | the two long-running processes really run               |
| the SPA works against the tenant-scoped data                      | the browser side of the isolation and of the plan       |

### What it found

The suite was written against a Cloud that had never run, and it found
five defects that would have reached the first paid deployment. They are
listed here because a suite that has never failed is a suite nobody
trusts:

| Defect | Why it mattered |
|---|---|
| the CLI died in PostgreSQL mode: the backtest and the maintenance commands called `process.exit(1)` while the command line was being built | every command was dead in the Cloud, including `dominus keys create` — the documented way to mint the first API key of a fresh deployment (`src/cli/commands/backtest-command.ts`, `maintenance-command.ts`) |
| the worker and the scheduler images set `PORT=0`, which the shared configuration rejects | both containers crash-looped at boot in every deployment that did not override the variable; the API kept serving, so the stack looked healthy (`Dockerfile`) |
| `dominus keys create` read the row it had written back for the *ambient* tenant, not the tenant it was written for | the bootstrap of a Cloud deployment writes outside any tenant scope on purpose: the read-back found nothing and the command crashed (`src/db/repositories/api-key-repository.ts`) |
| `dominus scheduler run <job>` answered "Unknown job" | the job definitions were created only by the scheduler's `start()`, which only the long-running scheduler process calls: the manual run was useless (`src/scheduler/scheduler-service.ts`) |
| the CLI never released the connection pool and the Redis client | in PostgreSQL mode every command printed its output and then hung — the operator's `dominus keys create` returned the key and never returned to the shell (`src/cli.ts`) |

Each of them is now covered by a regression test, and the worker and the
scheduler liveness is asserted by the docker smoke as well: a
crash-looping container is a failed stack, not a detail of one service.

### What it does NOT prove

These are the boundaries, and each one is the work list of the phase
that follows. They are not disclaimers.

| Gap                                    | Why it is out of scope                                    | Where it is covered                                   |
| -------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| the real DNS/RDAP/trademark providers  | a live lookup changes over time and is rate-limited        | the provider test suites; **one real run in staging** |
| the interactive SSO login and the CSRF guard | the stack runs `AUTH_PROVIDER=db`, which has no IdP     | **a manual smoke with a real identity provider**      |
| the Stripe tax engine and SCA           | test-mode events carry no tax calculation                 | the test-mode matrix in [billing-tax-verification.md](billing-tax-verification.md) |
| the point-in-time recovery              | a drill needs a real base backup and a WAL archive        | **the staging restore drill** (ADR-0054)              |
| the TLS terminator, the monitoring stack, the backups | that is the infrastructure, not the application | the Terraform apply and the external probe            |
| the production compose overlay          | the acceptance stack is the *data* topology, not the deployment | the docker gate and the applied plan          |

---

## 2. The staging runbook

The acceptance suite leaves four boundaries open. Staging is where they
are closed, on infrastructure that is disposable.

### 2.1 A separate staging environment

Staging is a **second Hetzner project** with its own state, its own
domain, its own B2 bucket and its own secrets. Never the production
ones: a rehearsal that shares a bucket with production is a rehearsal
that can delete production's backups.

```bash
# A second Hetzner project ("dominus-staging"), a second state file and
# a second tfvars. The Terraform is the same: the project variable, the
# domain and the bucket are what differ.
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars.staging
#   project      = "dominus-staging"
#   domain       = "staging.dominus.example"
#   image_tag    = "v1.3.1"          # a RELEASED tag, and it must exist
#   b2_backup    = { bucket = "dominus-staging-pitr", ... }
terraform workspace select staging || terraform workspace new staging
terraform init -backend-config=backend.hcl.staging
terraform apply
```

The deploy pipeline reaches staging only through an explicit dispatch,
never through a tag:

```bash
gh workflow run deploy.yml -f environment=staging -f tag=v1.3.1
```

The `production` environment of the same workflow is the one a release
tag deploys to. Each environment carries its own deploy secrets, so a
repository-level secret can no longer reach production by accident.

### 2.2 The real pipeline

The suite does not run the pipeline against the live providers. Once, in
staging, with the real Unbound, RDAP and trademark providers:

```bash
# On the app node, as the operator
KEYWORD_DATA_PATH=/opt/dominus/keywords.json \
COMPS_DATA_PATH=/opt/dominus/comps.csv \
node dist/cli.js run --sync --closeout-csv examples/closeout-sample.csv
```

The run must be **green**, not degraded: a degraded DNS stage means the
resolver is not validating, and a degraded run is a partial answer
(ADR-0002). Record the run id in the operations log.

### 2.3 The restore drill (the real one)

Mode 2 of `scripts/restore-drill.mjs` inspects a base backup's layout.
Mode 3 is the drill: it restores the data and compares the row counts.
Mode 3 needs a Linux host with the PostgreSQL client tools, a real base
backup and the WAL archive — the db node has all three.

```bash
# On the db node, as the operator
node scripts/restore-drill.mjs --pg-base /var/backups/dominus/base
node scripts/restore-drill.mjs --pg-restore \
  --base /var/backups/dominus/base \
  --wal  /var/lib/postgresql/data/archive \
  --target-time "2026-10-20 12:00:00+00"
```

Record the output, the measured RTO and the RPO in the operations log.
The restore drill is the evidence row of the launch checklist; a drill
that was never performed is a target, not a measurement (ADR-0094).

### 2.4 The identity provider

The suite runs `AUTH_PROVIDER=db`. The public Cloud uses an OIDC
provider, and that path has a different trust boundary: the tenant comes
from a team seat, not from an API key, and the session is a cookie.

Before the paid launch, one manual smoke with a real provider:

1. a free developer tenant of the identity provider, one user, one team
   seat;
2. sign in through the SPA, land on the dashboard, confirm the tenant in
   the session is the invited one;
3. confirm that a user without a seat is refused (the invitation
   boundary);
4. record the timestamp and the outcome in the operations log.

This is the one gap the automated suite cannot close on its own, and it
is cheap: minutes, not days.

---

## 3. The audit hand-off

The external auditor receives, in this order:

1. **[docs/security/audit-2026-08.md](../security/audit-2026-08.md)** —
   the first-party review of the same surface. It is the starting point,
   not a substitute.
2. **the acceptance report** — `.acceptance/report.json`, with the list
   of assertions and their results. The auditor can re-run it:
   `npm run acceptance:cloud`.
3. **the boundary table above**, with the staging evidence attached to
   each row: the pipeline run, the restore drill output, the identity
   provider smoke, the Stripe test-mode matrix.
4. **the launch checklist** ([launch-checklist.md](launch-checklist.md))
   — the gate the deployment has to pass.

The rule the auditor will apply: a claim without a command behind it is
a hypothesis. Everything in the list above is a command, with an output.
