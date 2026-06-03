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

## Project Status

This project is in early development. No production code exists yet. See [`CLAUDE.md`](CLAUDE.md) for the current development context.

## License

[MIT](LICENSE) &mdash; &copy; 2026 AlessioBrillo
