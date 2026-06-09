# DOMINUS

> Open-source decision-support engine for buying, reselling, and managing DNS domain portfolios on the aftermarket.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-3178C6)](tsconfig.json)
[![Version](https://img.shields.io/badge/version-0.2.0-blue)](package.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)
[![Open Source](https://img.shields.io/badge/open-source-first-333333)](#)

DOMINUS is an **open-source domain investment tool** that helps you make better purchase, portfolio, and pricing decisions than the market average. It is **free to use**, **free to fork**, **zero-cost on APIs**, and designed to run at **€0 infrastructure cost**.

## Why Open-Source?

Every aspect of DOMINUS is transparent, forkable, and customizable:

- **No vendor lock-in**: you own your data (SQLite file), your configuration (`.env`), and your fork
- **No black-box algorithms**: the scoring engine is heuristic — every weight, threshold, and signal is visible and tunable
- **No paid APIs**: all data sources are free (public RDAP, USPTO, EUIPO) or file-based (keyword CSVs, comparable sales)
- **No surprises**: fork the repo, change anything, deploy anywhere — from a Raspberry Pi to a Kubernetes cluster

## Pipeline Architecture

```
Candidates → DNS pre-filter → RDAP confirmation → Scoring → Trademark gate → Buy/Pass
```

Five sequential stages, each feeding the next:

1. **Candidate generation** — keyword combos, brandable names, closeout CSV imports
2. **DNS pre-filter** — fast bulk check via Node `dns` module
3. **RDAP confirmation** — precise availability + premium detection via public RDAP
4. **Scoring** — heuristic engine using intrinsic/commercial/market/expiry signals
5. **Trademark gate** — mandatory USPTO + EUIPO check (non-negotiable)

Plus a **portfolio tracker** with renewal clock and monthly keep/drop/reprice verdicts.

## Quick Start

```bash
# Clone anywhere, no registration required
git clone https://github.com/AlessioBrillo/dominus.git
cd dominus
npm install
npm run build

# Score some candidates with sample data (no config needed)
KEYWORD_DATA_PATH=examples/keywords-sample.json \
COMPS_DATA_PATH=examples/comps-sample.csv \
node dist/cli.js run --closeout-csv examples/closeout-sample.csv
```

Or with Docker:

```bash
docker build -t dominus .
docker run -d -p 3000:3000 -v ./data:/app/data dominus
```

## Current Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Backend** | Node.js 20+, Express 5 | Zero-cost, universally forkable, massive ecosystem |
| **Database** | SQLite (better-sqlite3, WAL mode) | Single file, zero ops, portable anywhere |
| **CLI** | Commander (12 commands) | Full functionality without a browser |
| **API** | Express REST (14 route modules) | Dashboard-ready, swappable frontend |
| **Trademark** | USPTO public API (no key) + EUIPO OAuth2 (free) | Zero-cost compliance |
| **Infrastructure** | Docker, Docker Compose, GitHub Actions | Deploy anywhere, CI built-in |

## Fork & Customize

DOMINUS is designed from the ground up to be forked and personalized. Here's what you can change without touching core code:

### Scoring Engine

Every tunable parameter is exposed via environment variables:

- **Signal strengths**: weights for intrinsic, commercial, market, expiry signals (`SCORING_WEIGHTS_OVERRIDE`)
- **Signal calibrations**: ideal length, volume caps, floor values (see `src/config.ts`)
- **TLD bonuses**: override `.com=1.0, .io=0.85` via JSON file (`TLD_BONUSES_PATH`)
- **Budget caps**: `BUY_MAX_ABSOLUTE_CAP`, `SCORING_RECOMMEND_THRESHOLD`
- **Drop logic**: `DROP_SCORE_THRESHOLD`, `DROP_RENEWAL_HORIZON_DAYS`

### Providers

Every external dependency is behind a TypeScript interface. Swap any provider in **one file** (`src/app/composition-root.ts`):

| Interface | Default | Swap to |
|-----------|---------|---------|
| `DnsProvider` | Node DNS (std lib) | Any DNS API |
| `RdapProvider` | rdap.org (free) | Custom RDAP bootstrap |
| `TrademarkProvider` | USPTO + EUIPO (free) | Commercial TM API |
| `KeywordProvider` | Local JSON file | Google Ads API, Ahrefs |
| `CompsProvider` | Local CSV file | NameBio API, Estibot |
| `WhoisProvider` | Port-43 (free) | WhoisXML API |
| `RegistrarProvider` | Manual (no-op) | Namecheap, GoDaddy, Cloudflare API |

See [Customization Guide](docs/customization/README.md) for step-by-step examples.

### Custom Signals

The scoring engine accepts four signals. To add a fifth (e.g. social media presence, PageRank):

1. Create `src/scoring/signals/social-signal.ts` implementing the signal contract
2. Wire it in `src/scoring/scoring-engine.ts`
3. Add its weight to `SCORING_WEIGHTS_OVERRIDE`

## Deployment Options

DOMINUS scales from a personal CLI tool to a containerized service managing thousands of domains:

| Scenario | Stack | Command |
|----------|-------|---------|
| **Personal** (1-50 domains) | CLI only | `npx dominus run --closeout-csv ./candidates.csv` |
| **Growing** (50-500) | Docker | `docker compose up -d` |
| **Large** (500+) | Docker + reverse proxy + scheduler | `docker compose -f compose.yml -f compose.prod.yml up -d` |
| **Enterprise** (5000+) | Kubernetes + PostgreSQL adapter | `kubectl apply -f deploy/` |

See [Deployment Guide](docs/deployment/README.md).

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and customize:

```bash
cp .env.example .env
# Edit .env with your preferences
```

Key variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_PATH` | `./data/dominus.db` | SQLite database location |
| `KEYWORD_DATA_PATH` | (optional) | Google Keyword Planner JSON export |
| `COMPS_DATA_PATH` | (optional) | NameBio comparable sales CSV |
| `BUY_MAX_ABSOLUTE_CAP` | `500` | Max recommended purchase price (EUR) |
| `SCORING_WEIGHTS_OVERRIDE` | (optional) | Custom scoring weights JSON |
| `TLD_BONUSES_PATH` | (optional) | Custom TLD multiplier bonuses JSON |
| `EUIPO_CLIENT_ID` | (optional) | EUIPO trademark search (free registration) |
| `API_KEYS` | (optional) | REST API authentication |

See [full reference](docs/customization/configuration.md).

## Commands

```
Usage: dominus <command> [options]

Commands:
  run                 Run the full pipeline
  score               Score a single domain
  portfolio           Manage portfolio (CRUD + rescore)
  outcome             Record outcomes (sold/dropped/expired)
  backtest            Run backtest + suggest weight adjustments
  runs                List/inspect pipeline runs
  candidates          List pipeline candidates
  providers           Show provider status
  scheduler           Run scheduled jobs manually
  watchlist           Monitor domains for availability
  maintenance         Prune cache, DB maintenance
  health              System health check
```

## Documentation

- [Architecture Decision Records](docs/adr/README.md) — full architectural rationale
- [Customization Guide](docs/customization/README.md) — how to adapt for your needs
- [Deployment Guide](docs/deployment/README.md) — infrastructure options
- [Contributing Guide](CONTRIBUTING.md) — how to contribute
- [Security Policy](SECURITY.md) — vulnerability reporting

## Project Status

DOMINUS v0.2.0 — production-ready, tested, and running end-to-end. All five pipeline stages, the heuristic scoring engine, trademark gate (real USPTO/EUIPO providers + caching), portfolio tracker, outcomes, and backtest engine are implemented and tested.

## License

[MIT](LICENSE) — © 2026 AlessioBrillo. Use freely, fork openly, build anything.
