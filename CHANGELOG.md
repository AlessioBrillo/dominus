# Changelog

All notable changes to DOMINUS are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-06-08

### Added
- ADR-0001 through ADR-0006 documenting foundational architecture decisions
- Dockerfile and docker-compose.yml for containerised deployment
- `dominus health` CLI command for system health checks
- SECURITY.md with vulnerability reporting policy
- CONTRIBUTING.md with development workflow guide
- CHANGELOG.md (this file)

### Changed
- Bumped version from 0.1.0 to 0.2.0
- Updated CLAUDE.md and README.md to reflect production-ready state
- All ADR references updated to point to ADR series instead of gitignored
  `dominus-product-vision.md`
- CI workflow to upgrade GitHub Actions runners ahead of Node.js 24 migration

### Removed
- `dominus-product-vision.md` from .gitignore (content extracted into ADRs)
- All references to `dominus-product-vision.md` across documentation and skills

## [0.1.0] — 2026-06-06

### Added
- Five-stage pipeline: candidate generation, DNS pre-filter, RDAP confirmation,
  scoring engine, trademark gate
- Heuristic scoring engine with 4 signals (intrinsic, commercial, market, expiry)
- Real USPTO and EUIPO trademark providers with caching and retry
- Portfolio manager with CRUD, rescore, and drop verdict engine
- Outcomes tracking (sold, dropped, expired, renewed)
- Backtest engine with point-in-time correctness, MAE/bias/calibration reports
- Weight suggester with two-gate activation (suggest → manually approve)
- CLI with 8 commands (run, score, portfolio, candidates, outcome, backtest,
  runs, maintenance)
- REST API with 8 route modules (health, candidates, score, portfolio, outcomes,
  backtest, runs, providers)
- SQLite persistence with 8 migrations (WAL mode, parameterised queries)
- Token-aware trademark matching with Levenshtein distance (ADR-0012)
- EUIPO provider migration to Trademark Search 1.1.0 (ADR-0014)
- Public Suffix List integration via `psl` package (ADR-0015)
- Provider abstraction pattern with 6 interfaces, caching and retry decorators
- CI pipeline via GitHub Actions (typecheck, build, lint, test)
- 414 tests across 56 test files (80% line coverage)
