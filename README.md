# DOMINUS

> Decision-support engine for buying and reselling DNS domains on the aftermarket.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-3178C6)](tsconfig.json)

DOMINUS is a personal domain-investment tool that helps you make better purchase and portfolio decisions than the market average. It is **single-user**, **zero-cost on APIs**, and designed for a tight budget (~500&euro;).

The core asset is a **heuristic scoring engine** that evaluates domain candidates and outputs buy/pass recommendations. The engine is deliberately more conservative than commercial appraisal tools.

## Pipeline Architecture

```
Candidates → DNS pre-filter → RDAP confirmation → Scoring → Trademark gate → Buy/Pass
```

Five sequential stages, each feeding the next:

1. **Candidate generation** &mdash; keyword combos, brandable names, closeout CSV imports
2. **DNS pre-filter** &mdash; fast bulk check via Node `dns` module
3. **RDAP confirmation** &mdash; precise availability + premium detection via public RDAP
4. **Scoring** &mdash; heuristic engine using intrinsic/commercial/market signals
5. **Trademark gate** &mdash; mandatory USPTO/EUIPO check (non-negotiable)

Plus a **portfolio tracker** with renewal clock and monthly keep/drop verdicts.

## Planned Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Database | SQLite (better-sqlite3) |
| Frontend | React + Vite + Tailwind (or CLI-only MVP) |
| Providers | Node `dns` / RDAP HTTP / WHOIS port-43 / Google Keyword Planner / NameBio / USPTO+EUIPO APIs |

All external providers sit behind interfaces (`WhoisProvider`, `CompsProvider`, `TrademarkProvider`, `KeywordProvider`) so implementations can be swapped without touching core logic.

## Key Design Decisions

- **Decision-first UX**: one question per candidate &mdash; *buy or pass*; one question per portfolio domain &mdash; *keep, drop, or reprice*
- **Trademark gate is non-negotiable**: never skippable, never optional
- **Provider abstraction is non-negotiable**: never hardcode an API client into core logic
- **Cost discipline**: no paid API in MVP; every feature works at &euro;0 infra cost
- **Renewal clock > acquisition volume**: a domain that doesn't sell is a recurring liability

## Getting Started

```bash
# Install dependencies
npm install

# Build
npm run build

# Development (with hot-reload)
npm run dev

# Type checking
npm run typecheck

# Run tests
npm test

# Lint
npm run lint
```

## Importing closeout candidates

The pipeline's first segment is **economic closeouts**. Feed a CSV of closeout/expiry
domains to the `run` command:

```bash
node dist/cli.js run --closeout-csv examples/closeout-sample.csv
```

The CSV is header-driven (column order is free; unknown columns ignored):

| Column | Required | Meaning |
|--------|----------|---------|
| `domain` | yes | the closeout domain name |
| `age` | no | domain age in years |
| `backlinks` | no | referring/backlink count |
| `wayback` | no | number of Wayback Machine snapshots |

`age`, `backlinks`, and `wayback` feed the **expiry signal** of the scoring engine. Rows
with a missing/invalid domain are skipped, so one bad line never aborts an import.

## Portfolio re-score and outcomes

The portfolio's drop verdicts only make sense when each entry has a fresh score. The
rescore command re-runs the scoring engine and the trademark gate against every owned
domain, writes the new calibrated 0-100 score and suggested list price, and refreshes
the verdicts:

```bash
# Re-score the whole portfolio
node dist/cli.js portfolio rescore

# Same, but only print the summary line (no per-domain table)
node dist/cli.js portfolio rescore --quiet
```

DNS and RDAP stages are intentionally skipped: an owned domain is already registered,
so DNS would just drop it. The trademark gate is rerun because new marks may have been
registered after acquisition; keyword/comps data may have drifted and the engine's
weights will be tuned over time.

Recorded outcomes are the data the engine will eventually be retrained against:

```bash
# Record a sale
node dist/cli.js outcome record --domain alpha.com --type sold --occurred-at 2026-04-15 \
  --sale-price 1500 --venue sedo --days-listed 240

# Record a drop
node dist/cli.js outcome record --domain beta.io --type dropped --occurred-at 2026-06-01

# List every recorded outcome
node dist/cli.js outcome list

# List a single domain's history
node dist/cli.js outcome list --domain alpha.com

# Aggregate stats for a domain
node dist/cli.js outcome stats --domain alpha.com
```

The REST equivalents:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/portfolio/rescore` | Re-score the whole portfolio |
| `GET`  | `/api/portfolio/:domain/outcomes` | List outcomes for a domain |
| `POST` | `/api/portfolio/:domain/outcomes` | Record a new outcome |
| `GET`  | `/api/portfolio/:domain/outcomes/stats` | Aggregate counts and realised revenue |
| `GET`  | `/api/candidates?runId=<id>` | List candidates for a pipeline run |

## Project Status

MVP implemented and running end-to-end (CLI + API, SQLite persistence): five-stage
pipeline, heuristic scoring engine, mandatory USPTO/EUIPO trademark gate, portfolio
tracker with rescore + outcomes, and a fresh 0-100 calibrated score that powers the
verdicts. Keyword and comparable-sales data remain free/manual by design. See
[`CLAUDE.md`](CLAUDE.md) for the current development context.

## License

[MIT](LICENSE) &mdash; &copy; 2026 AlessioBrillo
