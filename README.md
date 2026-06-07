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

## Backtest & calibration

The backtest command closes the loop between scoring predictions and the
realised `sold` outcomes you have recorded. It pairs each sale with the
scoring snapshot that was available *at the time of the sale* (point-in-time
correct), aggregates the pairs into MAE / bias / buy-max hit rate, and breaks
the metrics down by confidence bucket.

```bash
# Snapshot + report in one call (typical workflow)
node dist/cli.js backtest run

# Just rebuild the snapshot table (idempotent)
node dist/cli.js backtest snapshot

# Just print the report against the current snapshot
node dist/cli.js backtest report

# Machine-readable output for piping into other tools
node dist/cli.js backtest run --json

# Report without rebuilding (e.g. to compare against a saved snapshot)
node dist/cli.js backtest run --no-snapshot
```

Sample output:

```
DOMINUS backtest — generated 2026-06-06T14:32:11.000Z
Sample: 8 sold outcome(s)

Error on expected_value:
  MAE      €487
  Median   €312
  Bias     -€204  (over-predicting by 11% on average)

Buy-max accuracy (the metric that matters for capital):
  MAE         €212
  Hit rate    75.0%  (sale_price > suggested_buy_max)

Confidence calibration:
  bucket  n     MAE    realised   predicted
  low     2   €820       €310       €400
  mid     3   €445      €1180      €1050
  high    3   €210      €2450      €2300
```

The `backtest_signals` table is migration 0007 and is unique on
`(outcome_id, scoring_run_id)`, so re-running `backtest run` is safe and
idempotent. The point-in-time join (last `scoring_runs.scored_at <= outcome.occurred_at`)
is what makes the bias number honest — a re-run of the pipeline after a sale
will not retroactively inflate the engine's apparent accuracy.

### Calibrating engine weights from the backtest

The backtest report tells you *how* the engine is wrong (over-predicting,
under-predicting on high-confidence picks, etc.). The
`dominus backtest suggest-weights` command turns that report into a
proposed weight adjustment — and crucially, does **not** apply it
automatically:

```bash
# Propose weight adjustments based on the current backtest snapshot
node dist/cli.js backtest suggest-weights

# Same, but machine-readable
node dist/cli.js backtest suggest-weights --json

# Persist the suggestion to data/weights-override.json (no auto-activation)
node dist/cli.js backtest suggest-weights --apply
```

The algorithm splits each signal's sample into "high" (score ≥ 0.5) and
"low" (score < 0.5), computes the lift in mean realised price between
the two buckets, and proposes a `±0.02` weight delta (capped at
`±0.05`) when the lift exceeds `€50` in absolute value. With fewer than
5 sold outcomes in the sample, the suggester returns "hold" for every
signal — the engine will not act on insufficient evidence.

Activation is a **two-gate process** that satisfies Principle 5
(conservatism):

1. `dominus backtest suggest-weights --apply` writes
   `data/weights-override.json` with the proposed weights.
2. The engine reads the file **only** when you set
   `SCORING_WEIGHTS_OVERRIDE=./data/weights-override.json` in `.env`.

Touching one without the other is a no-op. The override file is validated
on every engine startup; an invalid JSON or a non-1.0 weight sum falls
back to the defaults with a stderr warning — the engine never crashes
on a malformed override.

The REST equivalents:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/portfolio/rescore` | Re-score the whole portfolio |
| `GET`  | `/api/portfolio/:domain/outcomes` | List outcomes for a domain |
| `POST` | `/api/portfolio/:domain/outcomes` | Record a new outcome |
| `GET`  | `/api/portfolio/:domain/outcomes/stats` | Aggregate counts and realised revenue |
| `GET`  | `/api/candidates?runId=<id>` | List candidates for a pipeline run |

## Pipeline runs history

Every `dominus run` (or `POST /api/candidates/run`) writes a row to
`pipeline_runs` *before* the orchestrator runs and completes it (with
duration, stage summary, results summary, and any error) when the run
ends. Rows are retained for **180 days** by default; pass a custom value
to `new PipelineRunService(..., retentionDays)` to override.

CLI:

```bash
dominus runs list [--since ISO] [--limit N] [--json]
dominus runs show <runId> [--json]
dominus runs prune [--dry-run]
```

REST:

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/runs` | List runs (newest first; `?since`, `?until`, `?limit`) |
| `GET`  | `/api/runs/:runId` | One run with stage + result summary |
| `GET`  | `/api/runs/:runId/candidates` | Candidates persisted during that run |
| `POST` | `/api/runs/prune` | Delete expired runs; returns `{ deleted, remaining }` |

Candidates persisted by a run share the same `pipeline_run_id` as the
`pipeline_runs.run_id`, so the join `pipeline_runs → candidates` is a
direct equality. See `docs/adr/0011-pipeline-runs-schema.md` for the
design rationale.

## Project Status

MVP implemented and running end-to-end (CLI + API, SQLite persistence): five-stage
pipeline, heuristic scoring engine, mandatory USPTO/EUIPO trademark gate, portfolio
tracker with rescore + outcomes, fresh 0-100 calibrated score that powers the
verdicts, and a backtest engine (`dominus backtest run`) that pairs every sold
outcome with the scoring snapshot available at decision time and reports MAE,
bias, buy-max hit rate, and per-confidence-bucket calibration. Keyword and
comparable-sales data remain free/manual by design. See
[`CLAUDE.md`](CLAUDE.md) for the current development context.

## License

[MIT](LICENSE) &mdash; &copy; 2026 AlessioBrillo
