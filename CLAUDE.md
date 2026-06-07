# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Trunk

The trunk branch is **`master`** (GitHub default branch for `AlessioBrillo/dominus`).
The `github-workflow` skill aligns to this. A future rename to `main` is
a deliberate, separate change.

## Project

DOMINUS is a personal decision-support tool for buying and reselling DNS domains on the aftermarket. It is single-user, zero-cost on APIs, and budget-constrained (~500€). The goal is not automation of buying/selling but producing better purchase/portfolio decisions than the market average.

The core asset is the **scoring engine**: a heuristic valuator that outputs `expected_value`, `confidence`, `suggested_buy_max`, and `suggested_list_price` per domain candidate. The engine must be more conservative than commercial appraisal tools, not more generous.

## Planned stack

- **Backend**: Node.js + Express
- **Database**: SQLite (single-user, zero-server; Postgres only if the project scales)
- **Frontend**: React + Vite + Tailwind (minimal dashboard or plain table for MVP)
- **Domain availability**: Node built-in `dns` module for pre-filter; RDAP public endpoints (no key required) for confirmation; WHOIS port-43 fallback for ccTLDs
- **Keyword data**: Google Keyword Planner (free with Ads account)
- **Comparables**: NameBio (manual lookup)
- **Trademark**: USPTO and EUIPO public APIs (free)

All external providers must sit behind interfaces: `WhoisProvider`, `CompsProvider`, `TrademarkProvider`, `KeywordProvider`. Free/manual implementations now; paid implementations swapped in later without touching core logic.

## Pipeline architecture

Five-stage pipeline — all stages are in scope for MVP; acquisition and auto-listing are manual and out of scope:

1. **Candidate generation** — keyword combos, brandable names, closeout CSVs imported manually
2. **DNS pre-filter** — fast bulk check via Node `dns`; drops obviously registered names
3. **RDAP confirmation** — precise availability status + premium detection via public RDAP
4. **Scoring** — heuristic engine (see below)
5. **Trademark gate** — mandatory USPTO/EUIPO check; any match blocks the candidate

Plus a **portfolio tracker** (Level 7): renewal clock per domain, monthly keep/drop verdict.

## Scoring engine signals

- **Intrinsic**: length, pronounceability, hyphens/numbers (penalty), TLD
- **Commercial**: keyword search volume × CPC from Google Keyword Planner
- **Market**: comparables from NameBio sales for similar names
- **For expired/closeout domains**: domain age, backlinks, Wayback history

Weights are tuned manually against real comparable sales. ML is out of scope at this scale — heuristic only.

## Key design decisions

- **Decision-first UX**: one question per candidate — *buy / pass*. One question per portfolio domain — *keep / drop / reprice*.
- **Trademark gate is non-negotiable** — it runs on every candidate before any buy recommendation.
- **Provider abstraction is non-negotiable** — never hardcode a specific API client into core logic.
- **Cost discipline**: any paid API is banned from MVP. Every feature must be implementable at €0 infra cost.
- **Renewal clock matters more than acquisition volume**: a domain that doesn't sell is a recurring liability. Drop logic is a first-class feature.

## Current project status

The MVP is implemented and runs end-to-end (TypeScript + SQLite, CLI + Express API). All five pipeline stages, the heuristic scoring engine, the trademark gate (real USPTO/EUIPO providers + caching), the portfolio tracker, portfolio re-score (scoring + TM gate against owned domains), and the outcomes table (sold / dropped / expired / renewed) are in place and tested. `dominus-product-vision.md` (v0.2) remains the authoritative spec.

Resolved v0.3 decisions (vision §11):

1. **Starting segment: economic closeouts first** — Stage 1 imports closeout CSVs (`run --closeout-csv`), carrying age/backlinks/wayback into the expiry signal.
2. **MVP interface: CLI** — the React dashboard is deferred.
3. Registrar for manual purchases — still open.
4. Drop policy — defaults live in config (`DROP_SCORE_THRESHOLD`, `DROP_RENEWAL_HORIZON_DAYS`); thresholds still being tuned.

Providers still on free/manual data by design: `KeywordProvider` and `CompsProvider` read optional local files (`KEYWORD_DATA_PATH`, `COMPS_DATA_PATH`).
