# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Trunk

The trunk branch is **`master`** (GitHub default branch for `AlessioBrillo/dominus`).
The `github-workflow` skill aligns to this. A future rename to `main` is
a deliberate, separate change.

## Project

DOMINUS is an open-source domain investment decision-support tool, available as
a self-hosted community edition (AGPL v3) and a managed cloud service
(DOMINUS Cloud). The community edition is single-user by default, zero-cost on
APIs, and runs at €0 infrastructure cost. DOMINUS Cloud adds multi-tenancy,
managed PostgreSQL, team accounts, and priority support.

The core asset is the **scoring engine**: a heuristic valuator that outputs
`expected_value`, `confidence`, `suggested_buy_max`, and `suggested_list_price`
per domain candidate. The engine must be more conservative than commercial
appraisal tools, not more generous.

See [ADR-0001](docs/adr/0001-project-architecture.md) for original architecture
decisions (superseded by ADR-0026, ADR-0027 for the SaaS era).

## Current stack

| Layer              | Technology                                                     |
| ------------------ | -------------------------------------------------------------- |
| **Backend**        | Node.js 22+, Express 5                                         |
| **Database**       | SQLite (community) / PostgreSQL (cloud)                        |
| **CLI**            | Commander (22 commands)                                        |
| **API**            | Express REST (34 route modules)                                |
| **Frontend**       | React 19 + Vite 8 + Tailwind CSS 4 + Recharts + TanStack Table |
| **Trademark**      | USPTO public API (no key) + EUIPO OAuth2                       |
| **Infrastructure** | Docker, Docker Compose, Terraform (Hetzner), GitHub Actions    |

See [ADR-0001](docs/adr/0001-project-architecture.md) for the original rationale
behind the technology choices. ADR-0025 through ADR-0028 document the SaaS
transition.

## Pipeline architecture

Five-stage pipeline with async-first execution — acquisition and auto-listing
are manual and out of scope:

1. **Candidate generation** — keyword combos, brandable names, closeout CSVs imported manually
2. **DNS pre-filter** — fast bulk check via Unbound recursive resolver
   (DNSSEC-validated; Node.js DNS fallback for non-Available verdicts only;
   never reports Available without DNSSEC validation)
3. **RDAP confirmation** — precise availability status + premium detection via public RDAP
4. **Scoring** — heuristic engine (see below)
5. **Trademark gate** — mandatory USPTO/EUIPO check; any match blocks the candidate

Pipeline runs are **async by default**: the CLI and API enqueue jobs to the
`job_queue` table and return immediately. The in-process `JobWorker` polls for
pending jobs and executes handlers asynchronously (configurable via
`WORKER_ENABLED`, default `true`). Callers can use `--sync` on the CLI,
`dominus runs wait <runId>` for polling, or the `/api/v1/runs/:id/job`
endpoint for API status. The `PipelineRunService` exposes both `runSync()`
and `enqueueRun()` paths; the legacy synchronous path is maintained for
backward compatibility.

Plus a **portfolio tracker**: renewal clock per domain, monthly keep/drop verdict.

All five stages are implemented and running. See [ADR-0003](docs/adr/0003-pipeline-stage-separation.md) for the architectural design.

## Scoring engine signals

- **Intrinsic**: length, pronounceability, hyphens/numbers (penalty), TLD
- **Commercial**: keyword search volume × CPC from Google Keyword Planner
- **Market**: comparables from NameBio sales for similar names
- **For expired/closeout domains**: domain age, backlinks, Wayback history.
  Wayback is fetched automatically (CDX provider); age and backlinks come from
  the imported closeout CSV — there is no backlink provider.

Weights are tuned manually against real comparable sales. ML is out of scope
at this scale — heuristic only. See [ADR-0002](docs/adr/0002-scoring-engine-design.md)
for the conservatism principle and [ADR-0008](docs/adr/0008-backtest-engine.md)
for the backtest-driven tuning loop.

## Key design decisions

- **Decision-first UX**: one question per candidate — _buy / pass_. One question
  per portfolio domain — _keep / drop / reprice_.
- **Trademark gate is non-negotiable** — it runs on every candidate before any
  buy recommendation. See [ADR-0006](docs/adr/0006-trademark-gate-mandate.md).
- **Provider abstraction is non-negotiable** — never hardcode a specific API
  client into core logic. See [ADR-0004](docs/adr/0004-provider-abstraction-pattern.md).
- **Cost discipline**: no paid API is required for the community edition.
  Every feature runs at €0 infra cost.
  See [ADR-0001](docs/adr/0001-project-architecture.md).
- **Community-first**: the AGPL community edition has every feature that
  DOMINUS Cloud has. Monetisation is on managed infrastructure, not feature gating.
  See [ADR-0025](docs/adr/0025-license-change-agpl-commercial.md).
- **Renewal clock matters more than acquisition volume**: a domain that doesn't
  sell is a recurring liability. Drop logic is a first-class feature.
- **Zero lock-in**: migrate from DOMINUS Cloud to self-hosted with a single
  database dump. The community edition reads the same schema.

## Production operations

- **Backup**: Automatic daily backup via scheduler (`SCHEDULER_BACKUP_CRON`, default: 04:00).
  Manual backup: `dominus maintenance backup`. See [ADR-0022](docs/adr/0022-backup-and-operations.md).
- **Database maintenance**: `dominus maintenance vacuum` runs integrity check + VACUUM.
- **Pruning**: `dominus maintenance prune` removes expired cache/runs data.
- **Local CI**: Pre-push hook runs full quality gate (typecheck, build, lint, format, test)
  before every push. No GitHub Actions minutes required.

## Project status

DOMINUS v1.3.2 — the front door: the first command a stranger runs
answers in about two seconds, creates nothing on disk and prints the
decision alone on stdout (the diagnostics moved to stderr, `--json` gives
the same decision to a script); `--help` and `--version` are answered from
the command line alone. The trademark gate fails closed: a source that
cannot answer leaves the domain unverified, and an unverified domain is
never recommended. The release state is checked against the world
(`npm run release:doctor`), and the documented quickstart is verified by
the gate (`npm run check:quickstart`). Before it: the legal surface for the
EU operator (art. 7 D.Lgs. 70/2003), the tax inputs and the withdrawal
consent at checkout, the data-subject rights (GDPR art. 15 and 17), a
launch gate that can be executed, and a published artifact that is verified
before and after the publish. v1.0.0 introduced the DOMINUS Cloud MVP.
Next: the infrastructure provisioned for real, the operator identity, the
USPTO endpoint migration, and the paid tiers behind the third-party audit.
See the [ADR series](docs/adr/README.md) for the full architecture documentation,
and [ROADMAP.md](ROADMAP.md) for planned releases.

Resolved design decisions:

1. **Starting segment: economic closeouts first** — Stage 1 imports closeout
   CSVs (`run --closeout-csv`), carrying age/backlinks/wayback into the
   expiry signal. See [ADR-0003](docs/adr/0003-pipeline-stage-separation.md).
2. **Interface: CLI + Dashboard** — the React dashboard is the primary UI for
   DOMINUS Cloud; the CLI remains fully functional for automation.
   See [ADR-0028](docs/adr/0028-frontend-architecture-professional-dashboard.md).
3. **Registrar**: manual purchases by default. The [RegistrarProvider]
   interface has one verified production implementation, Cloudflare;
   Dynadot, Porkbun and Namecheap providers are registered but marked
   experimental (unverified against vendor APIs — see ADR-0082). Use
   `REGISTRAR_PROVIDER=manual` (default) unless you have verified
   credentials.
   See [ADR-0004](docs/adr/0004-provider-abstraction-pattern.md).
4. **Drop policy** — defaults live in config (`DROP_SCORE_THRESHOLD`,
   `DROP_RENEWAL_HORIZON_DAYS`); thresholds are tuned via backtest feedback.
5. **Async-default execution** — pipeline runs enqueue to job_queue by default;
   call `--sync` for immediate synchronous execution. The worker is enabled
   by default (`WORKER_ENABLED=true`). See [ADR-0023](docs/adr/0023-job-queue-worker-pool-architecture.md).
6. **License**: AGPL v3 + commercial option. Community edition is free forever.
   See [ADR-0025](docs/adr/0025-license-change-agpl-commercial.md).
7. **SaaS model**: hosting-only monetisation — no feature gating.
   See [ADR-0026](docs/adr/0026-monetization-and-saas-model.md).
8. **Database abstraction**: SQLite for community, PostgreSQL for cloud.
   See [ADR-0027](docs/adr/0027-saas-architecture-multi-tenant.md).

Providers default to free/manual data: `KeywordProvider` reads an optional
local file (`KEYWORD_DATA_PATH`) or uses Google Suggest; `CompsProvider` reads
an optional local file (`COMPS_DATA_PATH`). Google Ads (keywords) and NameBio
(comparables) are optional API implementations. Adding a provider means one new
implementation file — no core logic changes. Providers that cannot be verified
against the real service are not shipped (see
[ADR-0082](docs/adr/0082-removal-of-unimplemented-features.md)).
See [ADR-0004](docs/adr/0004-provider-abstraction-pattern.md).

## CI gate

GitHub Actions is CI mirroring; the authoritative gate runs locally on the
committer's machine with Docker:

- **Local:** `npm run gate` from the repo root. Exit 0 = green.
  It runs typecheck → build → db:sync:check → lint → format:check →
  check:migration-compat → check:sql-portability → notices:check →
  adr:index:check → check:pack → release:verify --pack → check:doc-drift →
  check:release-consistency → **check:quickstart** → check:workflows →
  check:legal-placeholders → backend tests with coverage → frontend
  typecheck/lint/test-with-coverage/build → the end-to-end smoke gate
  (`npm run test:e2e:smoke`).
- **The quickstart gate:** `npm run check:quickstart` runs the command the
  README advertises, in a throwaway directory, and asserts the contract a
  reader is entitled to: exit 0, no log lines on stdout, the five numbers,
  nothing written to the disk, a time budget — and that the output
  documented in the README is the output the command produces.
- **The release state:** `npm run release:doctor` compares the version
  `package.json` announces with the world: a clean tree, a tag for the
  version, the tag on the remote, and — with `--remote` — the package on
  npm and the image in the registry. A release that is announced but not
  published is a command that fails, not a discovery days later.
- **End-to-end smoke:** the gate ends with a Playwright subset — auth,
  portfolio and the WCAG 2.1 AA gate — so the local gate cannot be green
  while the shipped SPA is broken. It needs the Chromium build once per
  machine: `npm run e2e:install`. The full suite stays in CI
  (`npm run test:e2e`). `SKIP_E2E_SMOKE=1` is the only escape hatch and it
  prints a warning in the log.
- **With Docker:** `npm run gate:docker` additionally renders both compose
  stacks, lints Prometheus alert rules, and (when Docker is available)
  starts base+Unbound and prod-overlay to assert `/api/v1/health` on a
  fresh Postgres volume. Run this before any tag or any change to
  compose/Dockerfile/deploy/.
- **Cloud acceptance:** `npm run acceptance:cloud` is the Cloud edition's
  own gate (ADR-0095): it builds the working tree's images, starts
  PostgreSQL with the production init script, applies the migrations as
  the owner role, runs the api/worker/scheduler against the non-superuser
  app role, and asserts tenant isolation (API and database), the Stripe
  webhook, the plan and usage surface, the GDPR export and erasure, the
  metrics token, the scheduler → queue → worker path, and three browser
  smokes. It needs Docker and the Chromium build (`npm run e2e:install`).
  It is not part of `npm run gate` (minutes, not seconds); CI runs it as
  its own job on every pull request.
- **Pre-push:** husky `pre-push` → `npm run gate`. Bypass only with an
  explicit `--no-verify`.
- **Done / merge-ready** means this gate is green on the final tree.
  See `~/.agents/CI.md`.
- **Secret scanning:** TruffleHog runs in CI over the pushed diff with
  verification enabled, so any credential-shaped URI in a tracked file is
  reported. Keep database URIs password-free in tracked files
  (`postgresql://<user>@<host>:5432/<db>`); the password goes in a
  separate variable.
