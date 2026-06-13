# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Trunk

The trunk branch is **`master`** (GitHub default branch for `AlessioBrillo/dominus`).
The `github-workflow` skill aligns to this. A future rename to `main` is
a deliberate, separate change.

## Project

DOMINUS is a personal decision-support tool for buying and reselling DNS domains on the aftermarket. It is single-user, zero-cost on APIs, and budget-constrained (~500€). The goal is not automation of buying/selling but producing better purchase/portfolio decisions than the market average.

The core asset is the **scoring engine**: a heuristic valuator that outputs `expected_value`, `confidence`, `suggested_buy_max`, and `suggested_list_price` per domain candidate. The engine must be more conservative than commercial appraisal tools, not more generous.

## Current stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Node.js 20+, Express 5 |
| **Database** | SQLite (better-sqlite3, WAL mode) |
| **CLI** | Commander (15 commands) |
| **API** | Express REST (15 route modules) |
| **Trademark** | USPTO public API (no key) + EUIPO OAuth2 |
| **Infrastructure** | Pre-push local quality gate (typecheck, build, lint, format, test) + optional Docker |

See [ADR-0001](docs/adr/0001-project-architecture.md) for the rationale
behind the technology choices. A future frontend dashboard (React + Vite +
Tailwind) is planned as a separate project phase but is not required for
daily operation.

## Pipeline architecture

Five-stage pipeline — acquisition and auto-listing are manual and out of scope:

1. **Candidate generation** — keyword combos, brandable names, closeout CSVs imported manually
2. **DNS pre-filter** — fast bulk check via Node `dns`; drops obviously registered names
3. **RDAP confirmation** — precise availability status + premium detection via public RDAP
4. **Scoring** — heuristic engine (see below)
5. **Trademark gate** — mandatory USPTO/EUIPO check; any match blocks the candidate

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
- **Cost discipline**: no paid API is used. Every feature runs at €0 infra cost.
  See [ADR-0001](docs/adr/0001-project-architecture.md).
- **Renewal clock matters more than acquisition volume**: a domain that doesn't
  sell is a recurring liability. Drop logic is a first-class feature.

## Production operations

- **Backup**: Automatic daily backup via scheduler (`SCHEDULER_BACKUP_CRON`, default: 04:00).
  Manual backup: `dominus maintenance backup`. See [ADR-0022](docs/adr/0022-backup-and-operations.md).
- **Database maintenance**: `dominus maintenance vacuum` runs integrity check + VACUUM.
- **Pruning**: `dominus maintenance prune` removes expired cache/runs data.
- **Local CI**: Pre-push hook runs full quality gate (typecheck, build, lint, format, test)
  before every push. No GitHub Actions minutes required.

## Project status

DOMINUS v0.3.0 — provider resilience, observability, and production hardening.

All five pipeline stages, the heuristic scoring engine, the trademark gate
(real USPTO/EUIPO providers + caching), the portfolio tracker, portfolio
re-score (scoring + TM gate against owned domains), the outcomes table
(sold / dropped / expired / renewed), and the backtest engine are in place
and tested. See the [ADR series](docs/adr/README.md) for the full
architecture documentation.

Resolved design decisions:

1. **Starting segment: economic closeouts first** — Stage 1 imports closeout
   CSVs (`run --closeout-csv`), carrying age/backlinks/wayback into the
   expiry signal. See [ADR-0003](docs/adr/0003-pipeline-stage-separation.md).
2. **Interface: CLI** — the React dashboard is deferred to a future phase.
   Current CLI has 15 commands covering all operations.
3. **Registrar**: manual purchases. A [RegistrarProvider]
   (src/providers/registrar/registrar-provider.ts) interface is available for
   future API integration with Namecheap, GoDaddy, or Cloudflare.
   See [ADR-0004](docs/adr/0004-provider-abstraction-pattern.md).
4. **Drop policy** — defaults live in config (`DROP_SCORE_THRESHOLD`,
   `DROP_RENEWAL_HORIZON_DAYS`); thresholds are tuned via backtest feedback.

Providers remain on free/manual data by design: `KeywordProvider` and
`CompsProvider` read optional local files (`KEYWORD_DATA_PATH`,
`COMPS_DATA_PATH`). A future upgrade to paid API providers requires only
a new implementation file swapping in — no core logic changes.
See [ADR-0004](docs/adr/0004-provider-abstraction-pattern.md).
