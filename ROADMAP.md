# Roadmap

DOMINUS v0.5.0-dev — production hardening, retry consolidation, benchmark suite.

This roadmap outlines the planned releases and their scope. Timelines are
estimates and subject to change.

## v0.4.0 — SaaS Foundation (previous)

> **Status**: Completed
> **Focus**: Documentation alignment, licensing, architecture decisions

- [x] ADR-0025: License change MIT → AGPL v3 + Commercial
- [x] ADR-0026: Monetization and SaaS model
- [x] ADR-0027: SaaS architecture (PostgreSQL, multi-tenancy, auth)
- [x] ADR-0028: Frontend architecture (professional dashboard)
- [x] All documentation aligned with SaaS direction
- [x] AGPL v3 LICENSE file replacement
- [x] COMMERCIAL_LICENSE.md with standard terms
- [x] Contributor License Agreement (CLA)
- [x] README badges updated with CI + coverage
- [x] OpenAPI/Swagger endpoint (`GET /api/v1/docs`)

## v0.5.0 — Production Hardening (current)

> **Status**: In development
> **Focus**: Security, code quality, retry consolidation, benchmarks

- [x] CSP hardening: removed `'unsafe-inline'` from `script-src`
- [x] AuthProvider wired through composition root (DI, not `new` in `src/index.ts`)
- [x] Per-token rate limiting on authenticated routes
- [x] Retry consolidation: `withRetryAndCircuitBreaker()` replaces 3 duplicated loops
- [x] Circuit breaker moved from `src/app/` to `src/providers/` (cross-cutting)
- [x] `DnsProvider` interface extracted to own file (provider idiom consistency)
- [x] `NodeDnsProvider` constructor injection (no `loadConfig()` at runtime)
- [x] Benchmark suite (vitest bench): pipeline throughput + DNS bulk lookups
- [ ] Codecov integration + coverage badge in README
- [x] API error handler consistency
- [x] Architecture diagrams (Mermaid) committed to `docs/diagrams/`
- [x] Automated changelog generation (standard-version or semantic-release)
- [x] Dockerfile Node version parameterisation
- [x] `.dockerignore` fix (tsconfig.json exclusion bug)
- [ ] SEO-ready README with screenshots/GIF demo

## v0.6.0 — Database Abstraction (complete)

> **Status**: Completed
> **Focus**: DatabaseProvider interface, PostgreSQL adapter

- [x] `DatabaseProvider` interface defined
- [x] SQLite implementation (existing code adapted)
- [x] PostgreSQL implementation (pg driver)
- [x] All 16 repositories refactored to use `DatabaseProvider`
- [x] CI runs tests against both SQLite and PostgreSQL
- [x] Migration path documented for existing SQLite users
- [x] Row-Level Security policies on all entity tables
- [x] Per-tenant backup/restore scripts

## v0.7.0 — Authentication & Multi-Tenancy

> **Status**: Planned
> **Focus**: User management, tenant isolation, JWT auth

- [ ] Auth0 or Clerk integration (managed identity provider)
- [ ] User registration + email verification
- [ ] Login/logout with JWT (short-lived + refresh tokens)
- [ ] API key management (per-user, bcrypt-hashed)
- [ ] `tenant_id` context resolution middleware
- [ ] All repository queries scoped by `tenant_id`
- [ ] Community edition retains static `.env` API key (backward compatible)
- [ ] CSP: remove `style-src 'unsafe-inline'` by extracting public page CSS to external files
- [ ] OAuth providers (Google, GitHub) — stretch goal

## v0.8.0 — Conversion Features & Onboarding Wizard (complete)

> **Status**: Completed
> **Focus**: Time-to-value < 7 minutes, portfolio import with savings callout

- [x] Onboarding wizard with stepper (sample run → portfolio import → verdict + savings)
- [x] `POST /api/v1/onboarding/sample-run` — synchronous sample pipeline execution
- [x] `POST /api/v1/portfolio/import` — CSV import with annual savings calculation
- [x] `SavingsCallout` component on dashboard post-onboarding
- [x] Empty-state redirect to onboarding wizard
- [x] Self-hosted analytics events table (`events`)
- [x] Activation funnel instrumentation (`time_to_activation`)
- [x] Shareable score pages (`/public/s/:slug`) with OG images

## v0.9.0 — Professional Frontend Dashboard (complete)

> **Status**: Completed
> **Focus**: Recharts, TanStack Table, shadcn/ui, SaaS UX

- [x] shadcn/ui component library integration (theme, primitives)
- [x] Recharts integration for Analytics page
- [x] TanStack Table for Portfolio, Candidates, Bids, Outcomes
- [x] React Hook Form + Zod for Settings, Bid placement, Onboarding
- [x] Auth flow: login → onboarding → dashboard
- [x] Error boundary + 404 route
- [x] Light/dark theme toggle
- [x] Responsive layout (collapsible sidebar, mobile support)
- [x] Loading skeletons for all pages
- [x] React Query hooks for all data fetching
- [ ] Accessibility pass (WCAG 2.1 AA, keyboard navigation, aria-labels)
- [ ] Frontend test coverage ≥50%

## v0.10.0 — Operations & Reliability

> **Status**: Planned
> **Focus**: Load testing, security audit, CI/CD maturity

- [ ] Load testing and performance benchmarking (see `npm run bench`)
- [ ] Security audit (dependency scan, CSP review, auth hardening)
- [ ] CI matrix testing (Node 20 + 22, ubuntu + windows)
- [ ] Frontend coverage thresholds raised to ≥50%
- [x] Automated changelog generation
- [x] Architecture diagrams (Mermaid) committed to `docs/diagrams/`
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
