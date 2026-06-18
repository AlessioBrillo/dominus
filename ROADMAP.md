# Roadmap

DOMINUS v0.4.0-dev — transitioning from single-user tool to open-source SaaS.

This roadmap outlines the planned releases and their scope. Timelines are
estimates and subject to change.

## v0.4.0 — SaaS Foundation (current)

> **Status**: In development
> **Focus**: Documentation alignment, licensing, architecture decisions

- [x] ADR-0025: License change MIT → AGPL v3 + Commercial
- [x] ADR-0026: Monetization and SaaS model
- [x] ADR-0027: SaaS architecture (PostgreSQL, multi-tenancy, auth)
- [x] ADR-0028: Frontend architecture (professional dashboard)
- [x] All documentation aligned with SaaS direction
- [ ] AGPL v3 LICENSE file replacement
- [ ] COMMERCIAL_LICENSE.md with standard terms
- [ ] Contributor License Agreement (CLA)
- [ ] README badges updated with CI + coverage
- [ ] OpenAPI/Swagger endpoint (`GET /api/v1/docs`)

## v0.5.0 — Showcase Polish

> **Status**: Planned
> **Focus**: Code quality, testing, documentation completeness

- [ ] Codecov integration + coverage badge in README
- [ ] CI matrix testing (Node 20 + 22, ubuntu + windows)
- [ ] Frontend coverage thresholds raised to ≥50%
- [ ] API error handler consistency (fix `listings.ts`, `analytics.ts`)
- [ ] Frontend: error boundary, 404 route, eslint-plugin-react-hooks
- [ ] Architecture diagrams (Mermaid) committed to `docs/diagrams/`
- [ ] Automated changelog generation (standard-version or semantic-release)
- [ ] Dockerfile Node version parameterisation
- [ ] CHANGELOG.md caught up with all releases
- [ ] `.dockerignore` fix (tsconfig.json exclusion bug)
- [ ] SEO-ready README with screenshots/GIF demo

## v0.6.0 — Database Abstraction

> **Status**: Planned
> **Focus**: DatabaseProvider interface, PostgreSQL adapter

- [ ] `DatabaseProvider` interface defined
- [ ] SQLite implementation (existing code adapted)
- [ ] PostgreSQL implementation (pg driver)
- [ ] All 16 repositories refactored to use `DatabaseProvider`
- [ ] CI runs tests against both SQLite and PostgreSQL
- [ ] Migration path documented for existing SQLite users
- [ ] Row-Level Security policies on all entity tables
- [ ] Per-tenant backup/restore scripts

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
- [ ] OAuth providers (Google, GitHub) — stretch goal

## v0.8.0 — Professional Frontend Dashboard

> **Status**: Planned
> **Focus**: Recharts, TanStack Table, shadcn/ui, SaaS UX

- [ ] shadcn/ui component library integration (theme, primitives)
- [ ] Recharts integration for Analytics page
- [ ] TanStack Table for Portfolio, Candidates, Bids, Outcomes
- [ ] React Hook Form + Zod for Settings, Bid placement, Onboarding
- [ ] Auth flow: login → onboarding → dashboard
- [ ] Error boundary + 404 route
- [ ] Light/dark theme toggle
- [ ] Responsive layout (collapsible sidebar, mobile support)
- [ ] Loading skeletons for all pages
- [ ] Accessibility pass (WCAG 2.1 AA, keyboard navigation, aria-labels)
- [ ] Frontend test coverage ≥50%

## v0.9.0 — DOMINUS Cloud MVP

> **Status**: Planned
> **Focus**: Managed hosting, billing, first paid tier

- [ ] DOMINUS Cloud infrastructure (VPS + PostgreSQL + reverse proxy)
- [ ] Free tier: rate-limited pipeline runs, single user
- [ ] Pro tier (€19/mo): 100 runs/day, 3 team seats, email support
- [ ] Stripe billing integration (subscriptions + customer portal)
- [ ] Usage metering (pipeline runs, API calls per tenant)
- [ ] Admin panel (user management, usage metrics)
- [ ] Onboarding flow for new signups
- [ ] Automated daily backups with point-in-time recovery
- [ ] Monitoring and alerting (uptime, error rate, latency)
- [ ] Migration guide: from community edition to DOMINUS Cloud

## v1.0.0 — GA Release

> **Status**: Planned
> **Focus**: Stability, production readiness, community launch

- [ ] Team tier (€49/mo): 500 runs/day, 10 team seats, Slack support
- [ ] Enterprise tier: custom pricing, SSO, SLA, dedicated infra
- [ ] End-to-end tests (Playwright/Cypress)
- [ ] Load testing and performance benchmarking
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
