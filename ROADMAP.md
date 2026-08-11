# Roadmap

DOMINUS v0.11.0 — DNS / RDAP / WHOIS consensus hardening (released).
Next: v1.0.0 — DOMINUS Cloud MVP (managed hosting).

This roadmap outlines the planned releases and their scope. Timelines are
estimates and subject to change.

## v0.4.0 — SaaS Foundation

> **Status**: Completed

- [x] ADR-0025 through ADR-0028
- [x] AGPL v3 + commercial license, CLA, OpenAPI docs

## v0.5.0 — Production Hardening

> **Status**: Completed
> **Focus**: Security, code quality, retry consolidation, benchmarks

- [x] CSP hardening, AuthProvider DI, rate limiting, retry consolidation
- [x] Circuit breaker, DnsProvider interface, benchmark suite
- [x] API error handler consistency, architecture diagrams, changelog generation
- [x] Codecov integration + coverage badge in README
- [ ] SEO-ready README with screenshots/GIF demo

## v0.6.0 — Database Abstraction

> **Status**: Completed

- [x] DatabaseProvider interface, SQLite + PostgreSQL adapters
- [x] All repositories refactored, RLS policies, migration path

## v0.7.0 — Authentication & Multi-Tenancy

> **Status**: Completed (foundation laid)
> **Focus**: User management, tenant isolation, JWT auth

- [x] API key management (DB-backed, scrypt hashed)
- [x] `tenant_id` context resolution middleware + RLS policies
- [x] Community edition retains static `.env` API key (backward compatible)
- [ ] Auth0 integration, OAuth providers, JWT refresh tokens

## v0.8.0 — Conversion Features & Onboarding Wizard

> **Status**: Completed

- [x] Onboarding wizard, portfolio import, savings callout
- [x] Shareable score pages, analytics events

## v0.9.0 — Professional Frontend Dashboard

> **Status**: Completed

- [x] Recharts, TanStack Table, shadcn/ui, auth flow, themes
- [x] Loading skeletons, React Query, error boundaries
- [ ] Accessibility pass (WCAG 2.1 AA)
- [x] Frontend test coverage ≥50%

## v0.10.0 — Operations & Reliability

> **Status**: Completed
> **Focus**: Load testing, security audit, CI/CD maturity, bridge repair

- [x] Fix: POST /portfolio/verdicts route (frontend 404 bug)
- [x] Fix: Cloudflare purchase priceEur: 0 bug
- [x] Fix: frontend login validation (API key verified against backend)
- [x] Tests: dan-listing-provider (0% → 85%+), auto-listing-service (0% → 90%+)
- [x] Tests: listings route (0% → 18 tests covering all CRUD + offers)
- [x] Pagination: Dan sync + Cloudflare listDomains
- [x] Load testing and performance benchmarking (see `npm run bench`; live-network benches against real resolvers/registries: `DNS_LIVE=1 npm run bench`)
- [x] DNS verdict hardening: 2-of-3 consensus on by default with endpoint-level
      disjointness enforcement (no shared resolver between primary and
      secondary), parking IP probe under rate limit/deadline/abort
- [x] Security: timing-safe API key comparison (`EnvApiKeyProvider`)
- [x] Rate limiting: distributed Redis-backed store for the public router
- [x] Backend test coverage thresholds raised to 70/65/60 (lines/functions/branches)
- [x] CI matrix testing (Node 20 + 22 ubuntu, Node 22 + 24 windows, native-bindings smoke check)
- [x] Compose topology fix: the documented prod command now starts the full
      stack (worker/scheduler by default; PG/Redis/monitoring via the prod
      overlay) — guarded by a CI job that asserts the service sets
- [x] Observability: Prometheus text-format endpoint
      (`GET /api/v1/metrics/prometheus`), self-hosted Prometheus +
      Alertmanager + Grafana in the prod profile, alert rules for API down /
      provider error rate / stage errors / stuck queue / dead letters
- [x] Restore drill script (`scripts/restore-drill.mjs`) — backup, restore,
      integrity_check and row-count comparison; failure path verified
- [x] CI matrix testing (Node 20 + 22 ubuntu, Node 22 + 24 windows, native-bindings smoke check)
- [x] Codecov integration + coverage badge in README
- [x] Security audit (dependency scan, CSP review, auth hardening) — `npm audit` clean on the root workspace; frontend residual advisories are limited to the react-router RSC-mode CSRF advisory (GHSA-qwww-vcr4-c8h2), which does not apply to this SPA and has no stable patched release yet
- [x] Frontend coverage thresholds raised to ≥50% (enforced in CI via `npm run test:coverage`; vitest thresholds 50/50/50 lines/functions/branches)

## v0.11.0 — Consensus Hardening (released)

> **Status**: Completed
> **Focus**: Availability-verdict trust, distributed rate limiting, usage enforcement

- [x] Usage enforcement at chokepoints (ADR-0038): metered candidate scoring, API calls, portfolio tracking
- [x] DNS consensus: majority-vote 2-of-3 gate on every resolution path (ADRs 0039, 0040), tertiary leg (0045), private recursor (0042), budget + DoH keep-alive pooling (0044), live-verified DoH legs (0047, 0048)
- [x] RDAP consensus: opt-in 2-of-2 second opinion (0050), WHOIS rescue leg + startup probe (0051), transport parity / undici pool (0049)
- [x] Distributed per-tenant fair share on shared Redis budgets (0041, 0052)
- [x] Configurable per-IP public rate limits (0043), image supply-chain pinning (0046)

## v0.10.1 — Hardening Polish

> **Status**: Completed (scope shipped with the v0.11.0 release)
> **Focus**: DNS consensus strictness, metrics access control, release docs

- [x] DNS verdict hardening: 2-of-3 consensus is now *strict* — a failed or
      unknown secondary resolver downgrades the verdict to Unknown instead
      of trusting the primary, plus a startup probe that fails fast when
      the consensus provider is misconfigured
- [x] DNS consensus failure policy (ADR-0039): fail-closed with a visible
      `consensus-unverified` degraded-run flag, majority + floor knobs
      (`DNS_CONSENSUS_DEGRADED_RATIO`/`_MIN`), and `dominus_dns_consensus_*`
      Prometheus tallies
- [x] Metrics access control: optional `METRICS_TOKEN` bearer auth on the
      `/api/v1/metrics/*` router (401 when set and not presented;
      unchanged when unset), with a commented Prometheus scrape
      authorization block for operators who enable it
- [x] Documentation: SQLite multi-process concurrency limits in the
      deployment guide, `.gitignore` covers benchmark output
- [x] SEO-ready README (FAQ, keyword-rich intro, semantic headings;
      screenshot/GIF demo deferred to v1.0.0 launch assets)

## v1.0.0 — DOMINUS Cloud MVP & Programmatic SEO

> **Status**: Planned (SEO surface shipped; managed hosting not started)
> **Focus**: Managed hosting, billing, paid tiers, SEO

- [ ] DOMINUS Cloud infrastructure (VPS + PostgreSQL + reverse proxy)
- [ ] Free tier: rate-limited pipeline runs, single user
- [ ] Pro tier (€29/mo): 100 runs/day, 3 team seats, email support
- [ ] Team tier (€79/mo): 500 runs/day, 10 team seats, Slack support
- [ ] Stripe billing integration (subscriptions + customer portal)
- [ ] Usage metering (pipeline runs, API calls per tenant)
- [ ] Admin panel (user management, usage metrics)
- [ ] Automated daily backups with point-in-time recovery
- [ ] Monitoring and alerting (uptime, error rate, latency)
- [ ] Migration guide: from community edition to DOMINUS Cloud
- [x] `AnonScoringService` — scoring engine in no-persist mode for public endpoints
- [x] `GET /public/domain/:name` — public domain valuation page (crawlable, cached)
- [x] `GET /sitemap.xml` — dynamic sitemap with public pages
- [x] `GET /public/compare/:slug` — editorial comparison pages
- [x] JSON-LD structured data for rich snippets
- [x] SSR layer for public pages (server-rendered HTML views — see
      [ADR-0030](docs/adr/0030-public-namespace-architecture.md))

## v1.1.0 — GA Release

> **Status**: Planned
> **Focus**: Stability, production readiness, community launch

- [ ] Enterprise tier: custom pricing, SSO, SLA, dedicated infra
- [ ] End-to-end tests (Playwright/Cypress)
- [ ] Security audit (third-party if budget allows)
- [ ] Public launch: Product Hunt, Hacker News, domain investor communities
- [ ] Case studies and documentation for common workflows
- [ ] Community Discord server

## Post-1.0

- **Real-time collaboration** — WebSocket-based shared pipeline views
- **Advanced analytics** — Portfolio diversification heatmaps, trend analysis
- **Name generator** — AI-assisted brandable domain generation
- **Marketplace integrations** — Afternic, Sedo, GoDaddy Auctions API
- **Mobile app** — Native notifications for renewal alerts and bid updates

---

> *This roadmap is a living document. Priorities may shift based on user
> feedback and business needs. See the [ADR series](docs/adr/README.md) for
> the rationale behind major decisions.*
