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

| Layer | Technology |
|-------|-----------|
| **Backend** | Node.js 20+, Express 5 |
| **Database** | SQLite (community) / PostgreSQL (cloud) |
| **CLI** | Commander (18 commands) |
| **API** | Express REST (18 route modules) |
| **Frontend** | React 19 + Vite 6 + Tailwind CSS 4 + Recharts + TanStack Table |
| **Trademark** | USPTO public API (no key) + EUIPO OAuth2 |
| **Infrastructure** | Docker, Docker Compose, GitHub Actions, K8s manifests |

See [ADR-0001](docs/adr/0001-project-architecture.md) for the original rationale
behind the technology choices. ADR-0025 through ADR-0028 document the SaaS
transition.

## Pipeline architecture

Five-stage pipeline with async-first execution — acquisition and auto-listing
are manual and out of scope:

1. **Candidate generation** — keyword combos, brandable names, closeout CSVs imported manually
2. **DNS pre-filter** — fast bulk check via Node `dns`; drops obviously registered names
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
- **For expired/closeout domains**: domain age, backlinks, Wayback history

Weights are tuned manually against real comparable sales. ML is out of scope
at this scale — heuristic only. See [ADR-0002](docs/adr/0002-scoring-engine-design.md)
for the conservatism principle and [ADR-0008](docs/adr/0008-backtest-engine.md)
for the backtest-driven tuning loop.

## Key design decisions

- **Decision-first UX**: one question per candidate — *buy / pass*. One question
  per portfolio domain — *keep / drop / reprice*.
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

DOMINUS v0.4.0-dev — transitioning to open-source SaaS architecture.
See the [ADR series](docs/adr/README.md) for the full architecture documentation,
and [ROADMAP.md](ROADMAP.md) for planned releases.

Resolved design decisions:

1. **Starting segment: economic closeouts first** — Stage 1 imports closeout
   CSVs (`run --closeout-csv`), carrying age/backlinks/wayback into the
   expiry signal. See [ADR-0003](docs/adr/0003-pipeline-stage-separation.md).
2. **Interface: CLI + Dashboard** — the React dashboard is the primary UI for
   DOMINUS Cloud; the CLI remains fully functional for automation.
   See [ADR-0028](docs/adr/0028-frontend-architecture-professional-dashboard.md).
3. **Registrar**: manual purchases. A [RegistrarProvider]
   (src/providers/registrar/registrar-provider.ts) interface is available for
   future API integration with Namecheap, GoDaddy, or Cloudflare.
   See [ADR-0004](docs/adr/0004-provider-abstraction-pattern.md).
4. **Drop policy** — defaults live in config (`DROP_SCORE_THRESHOLD`,
   `DROP_RENEWAL_HORIZON_DAYS`); thresholds are tuned via backtest feedback.
5. **Async-default execution** — pipeline runs enqueue to job_queue by default;
   call `--sync` for immediate synchronous execution. The worker is enabled
   by default (`WORKER_ENABLED=true`). See [ADR-0023](docs/adr/0023-async-default-execution.md).
6. **License**: AGPL v3 + commercial option. Community edition is free forever.
   See [ADR-0025](docs/adr/0025-license-change-agpl-commercial.md).
7. **SaaS model**: hosting-only monetisation — no feature gating.
   See [ADR-0026](docs/adr/0026-monetization-and-saas-model.md).
8. **Database abstraction**: SQLite for community, PostgreSQL for cloud.
   See [ADR-0027](docs/adr/0027-saas-architecture-multi-tenant.md).

Providers remain on free/manual data by design: `KeywordProvider` and
`CompsProvider` read optional local files (`KEYWORD_DATA_PATH`,
`COMPS_DATA_PATH`). A future upgrade to paid API providers requires only
a new implementation file swapping in — no core logic changes.
See [ADR-0004](docs/adr/0004-provider-abstraction-pattern.md).
