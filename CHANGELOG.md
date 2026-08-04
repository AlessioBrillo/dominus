# Changelog

All notable changes to DOMINUS are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note:** entries between 0.5.0-dev and 0.10.0-dev were not logged here as
> they shipped (see ROADMAP.md and git history for that period). Backfilling
> is a separate effort; new entries resume below at the current version.

## [Unreleased]

### Added
- `PUBLIC_APP_URL`: canonical site URL for the SSR public pages (canonical,
  OG, JSON-LD, sitemap, robots.txt). When unset, the request origin
  (protocol + Host, honoring `TRUST_PROXY_DEPTH`) is used — correct for
  self-hosted installs behind a reverse proxy.
- Dynamic `robots.txt` served at `/public/robots.txt` and `/robots.txt`
  with a `Sitemap` directive pointing at the resolved site origin.
- `AnonScoringService.dispose()` is now called during graceful shutdown so
  the public view-count flush timer can never fire after the database closes.

### Changed
- SSR public pages (score/domain/compare, JSON-LD breadcrumb/Organization,
  meta tags) no longer hardcode `https://dominus.app`; the site URL is
  resolved from `PUBLIC_APP_URL` or the request origin and is
  HTML-escaped in attribute contexts.
- `.env.example` aligned with the config schema: WHOIS rate-limit defaults
  (2 tokens / 2000ms) and the per-TLD overrides structure,
  `PIPELINE_TIMEOUT_MS` (1h), `PROVIDER_CACHE_TTL_DAYS` (7),
  `WATCHLIST_POLL_INTERVAL_HOURS` (6), `SCHEDULER_WATCHLIST_CRON`
  (`0 */6 * * *`), `DROP_NPV_DISCOUNT_RATE` (0.05),
  `REDIS_RETRY_BASE_MS` (200). `SCORING_CONFIDENCE_THRESHOLD` /
  `SCORING_RECOMMEND_THRESHOLD` marked deprecated (parsed but ignored).
- `docs/deployment/nginx.conf`: replaced the dead `location /static/`
  (phantom `root /var/www/dominus`) with `location /public/static/`
  proxying to the app, matching the Express-served public assets.
- README badges and project status updated to v0.10.0-dev.

### Fixed
- `PortfolioRdapService` was built end-to-end but never instantiated in
  `composition-root`, so the weekly portfolio renewal-date healthcheck
  against live RDAP/WHOIS silently never ran. Wired into the worker and
  scheduler.
- `DNS_PERSISTENT_CACHE_TTL_HOURS` was validated but ignored — the
  persistent DNS cache write hardcoded a 7-day TTL regardless of config.
  Now honored; default raised from 24 to 168 hours to preserve current
  runtime behavior.
- Removed dead config knobs `DNS_SEMAPHORE_CONCURRENCY`, `DNS_RESOLVER_URLS`
  (superseded by `DNS_RESOLVER_GROUPS`), and `DNS_HEALTH_CHECK_DOMAIN` (no
  production consumer).
- `EnvApiKeyProvider` now compares API keys in constant time (byte-wise
  comparison over all stored keys, no early exit), closing a timing side
  channel that could leak key prefixes.
- Backup retention pruning no longer relies on wall-clock mtime precision;
  tests pin the backup mtime explicitly so pruning is deterministic on
  filesystems with coarse mtime granularity (e.g. Windows).

### Added
- `DNS_CONSENSUS_ENABLED` / `DNS_CONSENSUS_STRATEGY`: opt-in 2-of-3 DNS
  resolver consensus cross-validation (default off). The feature existed
  and was unit-tested since the DNS multi-resolver work but was never
  wired into `composition-root`.
- Distributed rate limiting: Redis-backed `RedisRateLimitStore` wired into
  the public router (falls back to in-memory when Redis is absent), with
  per-domain limiters on public scoring endpoints.
- Onboarding and pipeline-runs API routes are now covered by integration
  tests; backend coverage thresholds raised to 70/65/60
  (lines/functions/branches).
- CI: backend matrix now runs Node 20/22 on Ubuntu and Node 22/24 on
  Windows, with a native-bindings (better-sqlite3 + sharp) load check and
  coverage uploaded to Codecov.

## [0.5.0-dev] — 2026-06-26

### Added
- ADR-0031: Production hardening — CSP, rate limiting, retry consolidation
- Benchmark suite (vitest bench): pipeline throughput and DNS bulk lookups
- `npm run bench` script for performance regression testing
- Per-token rate limiting on authenticated API routes
- `withRetryAndCircuitBreaker()` utility combining retry + circuit breaker
- `DnsProvider` interface extracted to own file (`dns-provider.ts`)
- `CircuitBreaker.cooldownMs` getter

### Changed
- CSP: removed `'unsafe-inline'` from `script-src` (Vite SPA bundles all scripts)
- AuthProvider built in `createDependencies()` and injected via `DominusDependencies`
- Auth middleware: `isActive` uses typed interface instead of unsafe cast
- Rate limiting split: auth endpoint (30 req/60s) separate from global API (100 req/15min)
- Circuit breaker moved from `src/app/` to `src/providers/` (cross-cutting pattern)
- `RetryingWhoisProvider`, `RetryingTrademarkProvider`, `RetryingRdapProvider`: delegated to `withRetryAndCircuitBreaker()`, removing ~50 lines of duplicate retry loop each
- `NodeDnsProvider`: config injected via constructor options instead of `loadConfig()` at runtime
- `NodeDnsProvider`: `name` property for observability
- eslint config: allow `.bench.ts` files to import vitest
- ROADMAP.md: updated with accurate release status through v0.9.0

### Removed
- Duplicate `RetryPolicy` interface from `retryable-provider.ts` (now imports from `retry-policy.ts`)
- `loadConfig()` calls from `NodeDnsProvider.checkAvailability()` and `checkBulk()`

## [0.4.0] — 2026-06-18

### Added
- ADR-0025: License change — MIT to AGPL v3 + Commercial
- ADR-0026: Monetization and SaaS model — DOMINUS Community vs DOMINUS Cloud
- ADR-0027: SaaS architecture — multi-tenancy, PostgreSQL, authentication
- ADR-0028: Frontend architecture — professional SaaS dashboard
- CONTRIBUTING.md: CLA requirement, dual-backend guidance (SQLite + PostgreSQL)
- GOVERNANCE.md: License section, DOMINUS Cloud section, CLA requirement
- ROADMAP.md with planned releases and feature timeline
- Architecture diagrams (Mermaid) documenting pipeline, provider abstraction, and SaaS architecture

### Changed
- License from MIT to AGPL v3 (v0.4.0+). Existing MIT releases (v0.1.0–v0.3.0) remain MIT.
- README.md: SaaS positioning, editions comparison table, architecture diagram, updated badges, 18 CLI commands
- CLAUDE.md: Updated for SaaS era with ADR-0025 through ADR-0028 references
- SECURITY.md: Added DOMINUS Cloud security design (JWT, RLS, bcrypt API keys)
- SUPPORT.md: Edition-aware support channels, DOMINUS Cloud support for paid plans
- ADR-0001: Status updated to Superseded (see ADR-0026, ADR-0027)
- ADR-0018: Status updated to Superseded (see ADR-0025, ADR-0026)
- Architecture-guardian skill: Updated for multi-tenant and PostgreSQL context
- package.json: License field → AGPL-3.0-only, added "files" field, version → 0.4.0-dev

## [0.3.0] — 2026-06-16

### Added
- Job queue and worker pool architecture (ADR-0023)
- Portfolio P&L tracking and analytics (ADR-0024)
- Listing manager with marketplace integrations (Dan.com)
- Bid management service
- Acquisition tracking service
- Portfolio report service
- Closed-loop auto weight tuning (ADR-0019)
- Provider resilience layer: circuit breakers, retry with jitter, failover providers
- Provider health check and status reporting
- Desktop, Telegram, and Webhook notifiers
- Watchlist with RDAP polling and availability notifications
- Scheduler service with configurable cron jobs
- Backup service with retention policy (ADR-0022)
- Rate-limited token buckets for USPTO, EUIPO, RDAP, WHOIS
- 723 test files across 36 test directories

### Changed
- Pipeline execution is async by default (enqueue to job_queue, worker polls)
- All provider interfaces hardened with timeout, retry, and circuit-breaker decorators
- Enhanced ScoringEngine with configurable confidence formula (ADR-0020)
- Improved error handling throughout with typed DominusError hierarchy

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
