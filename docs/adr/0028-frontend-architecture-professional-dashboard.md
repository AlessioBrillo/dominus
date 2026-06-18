# ADR-0028: Frontend Architecture — Professional SaaS Dashboard

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-06-18 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | ADR-0001 (partial — revises "CLI-first" frontend guidance) |
| **Relates to** | ADR-0026, ADR-0027 |
| **Project** | DOMINUS |

## Context

The current frontend (React 19 + Vite 6 + Tailwind CSS 4) was built as a Phase 1 minimal dashboard — functional enough to demonstrate the API but not designed for daily use as a primary interface. It has 7 pages, 6 components, and no charting library, data-table library, or form management. Test coverage is at 10%.

For DOMINUS Cloud (ADR-0026), the web dashboard is the primary interface. The CLI remains available and fully functional, but the SaaS offering's user experience depends on a polished, responsive, and feature-rich dashboard.

The gap between the current frontend and a professional SaaS dashboard is significant:

| Area | Current state | Target state |
|------|--------------|--------------|
| Charts | None (text + tables only) | Interactive charts (Recharts) |
| Tables | Basic HTML tables | Sorting, filtering, pagination (TanStack Table) |
| Auth | Static API key in localStorage | Login/signup, JWT, refresh tokens |
| Onboarding | None | Guided setup: API key creation, first pipeline run |
| Layout | Fixed sidebar (256px, desktop-only) | Responsive, collapsible, mobile-friendly |
| Theme | Dark-only | Light/dark toggle (Tailwind darkMode) |
| Accessibility | Unicode icons, no aria-labels | Keyboard navigation, screen-reader support |
| Error handling | Missing for some pages | Error boundaries, consistent error UX |
| Loading states | Text-based for some pages | Skeleton loading for all views |
| Coverage | 10% lines | ≥50% lines, ≥60% functions |

This ADR defines the frontend architecture and technology choices for the professional dashboard.

## Decision Drivers

1. **SaaS-ready UX** — The dashboard must support login, signup, onboarding, billing management, and tenant switching. This is a fundamental leap from the current single-user SPA.

2. **Performance** — Portfolio views must handle thousands of domains without lag. Virtual scrolling and efficient re-rendering are requirements, not optimisations.

3. **Solo-maintainer productivity** — Component libraries, pre-built auth UIs, and established patterns reduce maintenance burden. Building every component from scratch is not sustainable.

4. **Backend compatibility** — The frontend must work with both the community edition (static API key, SQLite) and DOMINUS Cloud (JWT auth, PostgreSQL, multi-tenant). A single build target.

5. **Accessibility** — A professional SaaS must meet WCAG 2.1 AA standards. This is both an ethical requirement and a legal consideration for EU-market SaaS.

## Considered Options

### Option A: Incremental Improvement of Current SPA

Keep the current React 19 + Vite + Tailwind stack. Add libraries incrementally: Recharts for charts, TanStack Table for data tables, React Hook Form for forms. Improve the existing pages rather than rewriting.

**Advantages:**
- Zero rewrite risk — existing pages continue to work during improvements
- Familiar stack — no new build tooling, no new routing paradigm
- Faster time-to-improvement for individual pages
- The current stack is modern (React 19, Vite 6, Tailwind 4) — no legacy debt

**Disadvantages:**
- The current codebase has uneven quality (some pages lack error handling, loading states)
- Auth system must be bolted on — the current localStorage API key pattern is incompatible with JWT/cookie auth
- The routing structure (single `main.tsx` with all routes) will not scale to auth-protected, tenant-aware routing
- No component library means every UI element (dropdown, modal, toast, date picker) must be built or sourced
- Solo-maintainer velocity suffers without a design system or component library

**Cost Implications:** ~50-80h for library integration, auth migration, and per-page improvements.

**Risk Assessment:** Low. The current stack is modern and familiar. The risk is mostly scope creep (each improvement looks small but adds up).

---

### Option B: Full Rewrite with Next.js + Tailwind

Rewrite the frontend in Next.js (App Router) with React Server Components, server-side data fetching, and API routes that proxy to the Express backend.

**Advantages:**
- Server-side rendering for SEO (relevant for landing/marketing pages)
- API routes can proxy authenticated requests without exposing backend internals
- Next.js has excellent DX with file-based routing, middleware, and edge functions
- Strong community and ecosystem for SaaS templates (Next Auth, Stripe integration examples)

**Disadvantages:**
- Full rewrite of ~2,300 lines of working code — high cost with uncertain benefit
- The Express backend already serves as the API layer — Next.js API routes would proxy to it, adding a network hop
- DOMINUS Cloud's value is in the backend (scoring, trademark, pipeline) — the frontend is a consumer, not the core
- SSR is irrelevant for an authenticated SaaS dashboard (no public content to index)
- Increases build complexity: two Node.js runtimes (Express + Next.js server) in production

**Cost Implications:** ~120-180h for a complete rewrite. Ongoing: two server processes to maintain.

**Risk Assessment:** Medium-high. A full rewrite of a working frontend for marginal benefit. The Express backend's REST API is stable and well-tested — replacing the frontend stack does not justify rebuilding the architecture.

---

### Option C: Current SPA + Professional Libraries + Component System (CHOSEN)

Keep React 19 + Vite 6 + Tailwind CSS 4. Add:
- **Charts**: Recharts (React-native charting, composable, well-maintained)
- **Tables**: TanStack Table v8 (headless, virtual scrolling, sorting, filtering, pagination)
- **Forms**: React Hook Form + Zod resolver (leverages existing Zod schemas from the backend)
- **Auth**: React Context + JWT handling (works with Auth0/Clerk from ADR-0027)
- **Routing**: React Router v7 with auth guards, tenant-aware layouts
- **UI primitives**: Headless UI (Radix UI) or shadcn/ui for accessible modal, dropdown, toast, tooltip
- **Design tokens**: Tailwind CSS variables for light/dark theme

**Advantages:**
- No rewrite — existing pages are improved in place, one at a time
- Familiar stack for the solo maintainer (no new framework to learn)
- Headless UI primitives from Radix/shadcn are accessible by default (WCAG-compliant)
- Recharts and TanStack Table are the gold standards in the React ecosystem for their domains
- React Hook Form + Zod gives type-safe forms that share schemas with the backend
- Vite 6 is already production-ready with fast HMR and efficient builds

**Disadvantages:**
- Library integration requires learning each library's API (Recharts, TanStack Table, React Hook Form)
- The current codebase has some patterns that must be refactored (auth flow, routing structure)
- Some pages may benefit from a near-rewrite rather than incremental improvement (OutcomesPage, SettingsPage)
- No server-side rendering (acceptable for an authenticated dashboard)
- Bundle size will increase with library additions (mitigated by code splitting)

**Cost Implications:** ~80-100h for full library integration, auth migration, page improvements, and accessibility pass. Library licenses: all MIT/Apache-2.0 (zero cost).

**Risk Assessment:** Low. Each library is well-documented, mature, and widely adopted. The incremental approach allows rolling back individual changes if they introduce regressions.

---

### Option D: shadcn/ui + Full Component Library Adoption

Use `shadcn/ui` as the primary component system. shadcn/ui is not a library you install — it's a collection of copy-pasteable components built on Radix UI primitives and styled with Tailwind CSS.

**Advantages:**
- Every component (button, card, dialog, dropdown, toast, table) is pre-built, accessible, and styled
- Components are copy-pasted into the project — full control over every line of code
- Tailwind-based styling integrates perfectly with the existing theme
- First-class dark mode support
- Excellent documentation and community

**Disadvantages:**
- Adding a component requires running `npx shadcn@latest add <component>` — more manual than `npm install`
- Updates to shadcn/ui components are manual (no version bump — you re-copy the component)
- Some library conflicts (shadcn/ui forms use React Hook Form + Zod — compatible with the chosen stack)
- Adds ~20 component files to the codebase (not a real disadvantage — they're well-structured)

**Cost Implications:** Zero cost (MIT licensed). Setup time: ~4h to add component suite and configure theme.

**Risk Assessment:** Low. shadcn/ui is the most popular React component system in 2026. The copy-paste model gives full control without dependency risk.

---

## Decision

**Chosen option: Option C + Option D (complementary) — Current SPA with professional libraries + shadcn/ui component system**

The frontend architecture combines the incremental approach of Option C with the component system of Option D. Specifically:

1. **Keep the build system**: Vite 6, Tailwind CSS 4, TypeScript strict — no changes needed.
2. **Add shadcn/ui** as the component foundation: install button, card, dialog, dropdown, toast, table, tabs, tooltip primitives.
3. **Add Recharts** for the Analytics page (prediction accuracy scatter plot, P&L chart, portfolio value over time).
4. **Add TanStack Table** for the Portfolio, Candidates, Bids, and Outcomes pages with sorting, filtering, and pagination.
5. **Add React Hook Form + Zod** for Settings, Bid placement, and Onboarding forms.
6. **Refactor auth** from localStorage API key to JWT context (Auth0/Clerk integration from ADR-0027). The community edition retains localStorage API key for backward compatibility.
7. **Refactor routing** to auth-protected routes with tenant-aware layout (React Router v7 loaders).
8. **Add React Error Boundary** (`react-error-boundary` package) wrapping the app and each major page.

### UI Architecture

```
App
├── ErrorBoundary
├── AuthProvider (JWT context)
├── ThemeProvider (light/dark)
├── Router
│   ├── Public routes
│   │   ├── /login
│   │   ├── /signup
│   │   ├── /forgot-password (future)
│   │   └── /onboarding (post-signup flow)
│   └── Protected routes (require auth)
│       ├── DashboardLayout (sidebar + top nav)
│       │   ├── /dashboard          → Portfolio stats, system health, alerts
│       │   ├── /candidates         → Pipeline results (TanStack Table)
│       │   ├── /portfolio          → Domain table (TanStack Table, virtual scroll)
│       │   ├── /analytics          → Prediction accuracy (Recharts)
│       │   ├── /analytics/pnl      → P&L chart (Recharts)
│       │   ├── /outcomes           → Outcomes table (TanStack Table)
│       │   ├── /bids               → Bid management (TanStack Table)
│       │   ├── /settings           → Settings (React Hook Form + Zod)
│       │   ├── /settings/team      → Team management (future)
│       │   ├── /settings/billing   → Subscription management
│       │   └── /admin (owner-only) → User management, usage metrics
│       └── NotFound (404)
```

### Library Decisions

| Concern | Library | Rationale |
|---------|---------|-----------|
| Charts | Recharts | React-native, composable, good defaults for scatter/line/bar charts |
| Tables | TanStack Table v8 | Headless, virtual scrolling, sorting/filtering/pagination, framework-agnostic |
| Forms | React Hook Form + Zod resolver | Share validation schemas with backend Zod types |
| UI primitives | shadcn/ui (Radix-based) | Accessible, copy-pasteable, Tailwind-styled |
| Error boundary | react-error-boundary | Standard pattern, resets state on retry |
| Auth | Auth0 SDK / Clerk SDK + React Context | From ADR-0027 — managed identity provider |
| Toast notifications | shadcn/ui sonner | Lightweight, accessible toast system |
| Date handling | date-fns | Tree-shakeable, immutable, comprehensive |
| Testing | Vitest + Testing Library + MSW | Already in the project; MSW for API mocking |

### Non-Goals

- SSR / SSG / Next.js — not needed for an authenticated SaaS dashboard
- State management library (Redux, Zustand, Jotai) — React Context + hooks suffice at this complexity level
- Monorepo — the current `frontend/` directory structure works well
- PWA / offline support — DOMINUS Cloud is always-online by nature
- Real-time collaboration — deferred to v1.0+ (requires WebSockets)

## Consequences

### Positive
- Zero rewrite risk — existing pages improved incrementally
- shadcn/ui provides accessible, professional-looking components out of the box
- Recharts + TanStack Table are the gold standards for their domains
- Auth migration from localStorage to JWT improves security posture
- Error boundaries prevent full-app crashes from single-component failures
- Light/dark theme toggle is a small effort with high perceived value
- Shared Zod schemas between frontend and backend reduce duplication

### Negative
- ~80-100h development investment for the full dashboard transformation
- shadcn/ui manual update process (each component update requires re-adding)
- Bundle size increase from library additions (mitigated by Vite code splitting)
- Some existing page code may need near-rewrites (OutcomesPage, SettingsPage)

### Compliance and Security Implications
- JWT auth replaces localStorage API keys — no credential exposure to XSS
- Auth0/Clerk provide SOC2-compliant identity management
- WCAG 2.1 AA compliance via Radix UI primitives (keyboard navigation, screen-reader support)
- GDPR-required features (account deletion, data export) are first-class UI flows
- CSP headers (from backend security middleware) must allow CDN-loaded chart fonts/images

### Migration and Monitoring Plan
- **Phase 1 (v0.4.0)**: Install shadcn/ui, set up theme, add error boundary, add 404 route, add React Hook Form + Zod, add Recharts for Analytics page. Fix existing gaps (OutcomePage error handling, eslint-plugin-react-hooks).
- **Phase 2 (v0.5.0)**: Auth migration (JWT), TanStack Table for portfolio/candidates, routing refactor to auth-protected routes. New pages: signup, onboarding, billing.
- **Phase 3 (v0.6.0)**: Team management, admin panel, accessibility pass (keyboard navigation audit, screen-reader testing, colour contrast validation).
- **Validation**: Lighthouse score ≥90 for all pages. All existing tests pass. No regression in existing functionality.

### Validation
- Lighthouse performance ≥90, accessibility ≥90, best practices ≥90
- Frontend test coverage ≥50% lines
- Page load time <2s for portfolio view with 1000 domains (with virtual scrolling)
- Dark/light theme toggle works without page reload
- Auth flow (login → onboarding → dashboard) completes in <30 seconds on a typical connection
- Zero uncaught render errors in production (error boundary captures and reports)

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`.*
