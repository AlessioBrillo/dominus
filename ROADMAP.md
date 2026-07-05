# Roadmap

DOMINUS v0.10.0-dev — operations, reliability, and production hardening.

This roadmap outlines the planned releases and their scope. Timelines are
estimates and subject to change.

## v0.4.0 — SaaS Foundation

> **Status**: Completed

- [x] ADR-0025 through ADR-0028
- [x] AGPL v3 + commercial license, CLA, OpenAPI docs

## v0.5.0 — Production Hardening

> **Status**: Completed (except README polish)
> **Focus**: Security, code quality, retry consolidation, benchmarks

- [x] CSP hardening, AuthProvider DI, rate limiting, retry consolidation
- [x] Circuit breaker, DnsProvider interface, benchmark suite
- [x] API error handler consistency, architecture diagrams, changelog generation
- [ ] Codecov integration + coverage badge in README
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
- [ ] Frontend test coverage ≥50%

## v0.10.0 — Operations & Reliability (current)

> **Status**: In development
> **Focus**: Load testing, security audit, CI/CD maturity, bridge repair

- [x] Fix: POST /portfolio/verdicts route (frontend 404 bug)
- [x] Fix: Cloudflare purchase priceEur: 0 bug
- [x] Fix: frontend login validation (API key verified against backend)
- [x] Tests: dan-listing-provider (0% → 85%+), auto-listing-service (0% → 90%+)
- [x] Tests: listings route (0% → 18 tests covering all CRUD + offers)
- [x] Pagination: Dan sync + Cloudflare listDomains
- [ ] Load testing and performance benchmarking (see `npm run bench`)
- [ ] Security audit (dependency scan, CSP review, auth hardening)
- [ ] CI matrix testing (Node 20 + 22, ubuntu + windows)
- [ ] Frontend coverage thresholds raised to ≥50%
- [ ] Codecov integration + coverage badge in README
- [ ] SEO-ready README with screenshots/GIF demo

## v1.0.0 — DOMINUS Cloud MVP & Programmatic SEO

> **Status**: Planned
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
- [ ] `AnonScoringService` — scoring engine in no-persist mode for public endpoints
- [ ] `GET /public/domain/:name` — public domain valuation page (crawlable, cached)
- [ ] `GET /sitemap.xml` — dynamic sitemap with public pages
- [ ] `GET /public/compare/:slug` — editorial comparison pages
- [ ] JSON-LD structured data for rich snippets
- [ ] SSR layer for public pages (React renderToString)

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
