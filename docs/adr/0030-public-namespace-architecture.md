# ADR-0030: Public Namespace Architecture

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-06-21 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0027, ADR-0029, ADR-0026, ADR-0018 |
| **Project** | DOMINUS |

## Context

ADR-0029 defines three conversion-driven features that require a public, unauthenticated HTTP surface: shareable score pages (Feature B) and programmatic SEO pages (Feature C). The onboarding wizard (Feature A) remains within the authenticated tenant-scoped API.

The current architecture has no concept of a public namespace. Every Express route is mounted under `/api/v1/*` and protected by the authentication middleware. The SPA catch-all serves the React frontend for all non-API paths. Introducing public endpoints requires an architectural decision about how to isolate them from authenticated, tenant-scoped routes.

Four architectural concerns drive this decision:

1. **Tenant isolation**: Public endpoints must never access tenant-scoped tables. A routing error, middleware misconfiguration, or future code change must not be able to leak portfolio data through a public endpoint.

2. **Rate limiting**: Public endpoints face different abuse vectors than authenticated ones (scraping, SEO crawler overload, DoS). A single global rate limiter is inappropriate — public endpoints need per-IP limits, while authenticated endpoints need per-tenant limits.

3. **Caching strategy**: Public endpoints serve identical content to all visitors (same domain score, same snapshot). They benefit from aggressive caching (CDN, in-memory, HTTP `Cache-Control` headers). Authenticated endpoints serve tenant-specific data and cannot be cached at the CDN level.

4. **Rendering model**: The current frontend is a client-side React SPA. Search engine crawlers execute minimal JavaScript, so SPA-rendered content is invisible to Googlebot. Public pages intended for SEO must be server-rendered or prerendered. The authenticated dashboard can remain an SPA — there is no requirement for dashboard pages to be crawlable.

## Decision Drivers

1. **Tenant isolation is non-negotiable** — Public endpoints must have zero access path to tenant data. The isolation mechanism must work at the router level, not rely on application logic that could be bypassed by a future code change.

2. **Cache architecture must be simple and effective** — Public endpoints should be cacheable at multiple levels (in-memory, CDN) with minimal configuration. Stale-while-revalidate is preferred over cache purging for simplicity.

3. **Minimal changes to the authenticated SPA** — The React dashboard should remain unchanged. SSR should be introduced only for the public namespace, not retrofitted onto the entire application.

4. **Cost discipline** — The public namespace must not introduce paid API calls or expensive rendering infrastructure. SSR for public pages should be lightweight (Node.js `renderToString` or equivalent, not a full SSR framework migration).

5. **SEO best practices** — Public pages must serve complete HTML with structured data (JSON-LD), OG tags, canonical URLs, and a dynamic sitemap. The rendering engine must produce crawlable output without JavaScript execution.

## Considered Options

### Option A: Embedded Public Routes in the Existing Express App

Mount public routes directly on the same Express app, using a path prefix (`/public/*`) but within the same middleware stack. Add conditional logic in the auth middleware to skip authentication for `/public/*` paths.

**Advantages:**
- Simplest implementation — one Express app, one middleware stack
- No additional processes or deployments
- Reuses existing error handling, logging, and metrics middleware
- Easy to deploy — single Docker container

**Disadvantages:**
- Auth middleware must inspect every request path — easy to get wrong with path variations
- One misconfiguration (e.g., a new route added before the public check) could expose tenant data
- The SPA catch-all (`app.get(spaPattern, ...)`) must be updated to exclude `/public/*`
- Cache middleware must be applied selectively (not cache tenant-scoped responses)
- Rate limiting must differentiate between public (per-IP) and authenticated (per-tenant) — complex with a single middleware stack
- Testing is harder because public and authenticated paths share the same app instance

**Cost Implications:** ~4h development. €0 operational cost.

**Risk Assessment:** Medium-high. The shared middleware approach violates defence-in-depth. A single conditional check in the auth middleware is the only barrier between public users and tenant data. This is acceptable for a prototype but not for production with RLS (ADR-0027).

---

### Option B: Separate Express Router Mounted Before Auth Middleware (CHOSEN)

Create a separate Express `Router` for `/public/*` paths and mount it **before** the auth middleware in the main app. This router has its own rate limiter, its own cache layer, and no access to the `req.tenant` context. The SPA catch-all explicitly excludes `/public/*` paths.

```
app.use('/public', publicRouter);         // No auth, no tenant
app.use('/api', authMiddleware, apiRouter); // Auth + tenant
app.get(spaPattern, spaHandler);           // SPA catch-all (excludes /public and /api)
```

**Advantages:**
- Router-level isolation — the auth middleware never sees public requests
- No conditional logic in auth middleware — it either runs (for `/api/*`) or doesn't (for `/public/*`)
- Public router has its own middleware stack (rate limiter, cache, CORS for public origins)
- Impossible for a public route handler to accidentally access `req.tenant` — the context isn't set
- Easy to test — public and authenticated routes can be tested independently
- Clear separation of concerns — the public router is a self-contained module

**Disadvantages:**
- Two parallel middleware stacks to maintain
- Common middleware (error handler, request logger, security headers) must be applied to both or extracted
- The SPA catch-all must be explicitly configured to ignore `/public/*` paths
- CDN configuration must map `/public/*` to cache rules and `/api/*` to proxy-only

**Cost Implications:** ~8h development. €0 operational cost.

**Risk Assessment:** Low. This is a standard pattern (public API + private API on the same server). Router-level isolation is enforced by Express itself — the auth middleware function never runs for public routes.

---

### Option C: Separate Subdomain or Process

Serve public pages from a separate process or subdomain (e.g., `public.dominus.cloud`). This could be a lightweight Express app or a static site generator that produces HTML for known domain scores.

**Advantages:**
- Complete isolation — no shared process, no shared memory, no shared database connections
- Independent scaling — the public surface can be deployed to a CDN/edge network
- Different technology stack possible for the public renderer (e.g., Astro for static generation)
- No risk of auth middleware misconfiguration affecting public routes

**Disadvantages:**
- Significantly more infrastructure — two Docker containers, two deployments, two monitoring dashboards
- Database access requires a separate connection pool with read-only credentials
- SSR would need to be built twice if the stack differs
- The shareable score creation flow (authenticated POST → public GET) crosses deployment boundaries
- CI/CD complexity — coordinated deployments across two services
- Over-engineered for the expected scale (hundreds, not millions of daily public pageviews)

**Cost Implications:** ~40h development. €10-30/month additional infra (second container, CDN configuration).

**Risk Assessment:** Low for security, high for operational complexity. The isolation is ideal but the operational overhead is disproportionate for a solo-founder project. The public surface is unlikely to reach traffic levels that justify a separate process.

---

### Option D: Static Site Generation for SEO Pages

Pre-generate HTML pages for known domain scores at build time or via a scheduled job. Serve them as flat HTML files from a CDN. Shareable score pages (dynamically created by users) are served via SSR on-demand.

**Advantages:**
- Fastest possible page load — static HTML from CDN edge
- No SSR infrastructure needed for the bulk of SEO pages
- Zero runtime cost for pre-generated pages
- Easy to cache aggressively (immutable HTML files)

**Disadvantages:**
- Cannot pre-generate pages for domains that haven't been scored yet — the long tail of domain queries would be dynamic anyway
- Shareable scores are created on-demand — SSG doesn't help there
- A pre-generation job adds complexity to the scheduler or CI pipeline
- The set of "valuable domains to pre-generate" requires a prioritisation heuristic
- Any change to the scoring engine requires regenerating all pre-generated pages
- Not suitable as the sole rendering strategy — dynamic SSR is still needed for on-demand requests

**Cost Implications:** ~16h development for the SSG pipeline. CDN storage costs: negligible (~€1/month for 100k pages at ~10KB each).

**Risk Assessment:** Low-medium as a supplement to SSR, but insufficient as the primary rendering strategy. This is a future optimisation, not a replacement for Option B.

---

## Decision

**Chosen option: Option B — Separate Express Router Mounted Before Auth Middleware**

The rationale:

1. **Defence-in-depth**: The router-level boundary means the auth middleware never executes for `/public/*` requests. Even if a future developer accidentally imports a tenant-scoped repository into a public route handler, there is no `req.tenant` context to use. This is consistent with the defence-in-depth principle from ADR-0027 (RLS is the safety net, router isolation is the primary barrier).

2. **Simple to implement and reason about**: The architecture is a single file — `src/api/public-router.ts` — that exports a configured Express Router. It is mounted in `src/index.ts` before the auth middleware. Every developer can understand the isolation boundary by looking at the mount order.

3. **Single-process simplicity**: For a solo-founder project, every additional process or deployment is a potential point of failure. One Express app, one Docker container, one monitoring dashboard. The public namespace is a routing concern within the same process.

4. **Progressive enhancement**: The public router starts simple (rate limiter → cache → handler) and can be extended later (CDN integration, edge caching, separate subdomain at scale) without changing the API contract.

5. **Rejecting Option C (separate process)**: The operational complexity of a second service is not justified at the expected scale. If the public surface grows beyond what a single process can handle, the separation can be made at that point — the router-level abstraction makes this a refactor, not a rewrite.

### Rendering Strategy for SEO Pages

For the server-rendered public pages (required by ADR-0029), the chosen approach is a lightweight Node.js SSR layer using React's `renderToString` (or `renderToPipeableStream` for performance) within the public router itself. This avoids introducing a full SSR framework (Next.js, Remix) that would require migrating the entire frontend.

The architectural decision is:

- The authenticated dashboard remains a client-side SPA (React 19 + Vite 6, unchanged)
- The public namespace uses a separate minimal React app or pure template rendering for SEO pages
- SSR is implemented as a middleware function in the public router that renders HTML with inlined critical CSS
- OG images are generated server-side using a canvas library (to avoid Puppeteer dependencies)

This split rendering model is documented in the system architecture:
```
┌─────────────────────────────────────────────────────┐
│ Express app (single process)                        │
│                                                     │
│  /api/v1/*  → authMiddleware → tenantCtx → repos    │
│             → SPA React (client-side)               │
│                                                     │
│  /public/*  → publicRateLimit → inMemoryCache        │
│             → anonScoringService                     │
│             → SSR React (server-side, SEO pages)     │
│             → public_scores (no tenant_id)           │
└─────────────────────────────────────────────────────┘
```

### Caching Architecture

| Layer | Target | Strategy | TTL |
|-------|--------|----------|-----|
| **In-memory** | `/public/s/:slug`, `/public/domain/:name` | LRU cache with TTL | 5 minutes |
| **CDN (Cloud)** | All `/public/*` | `Cache-Control: public, max-age=300, stale-while-revalidate=86400` | 5 min + 24h stale |
| **Database** | `public_scores` | Immutable snapshots, no invalidation needed | Permanent |

## Consequences

### Positive
- Router-level isolation guarantees tenant data safety without relying on application logic
- Single-process deployment keeps operational complexity low
- Existing SPA frontend remains completely unchanged
- Public namespace is independently rate-limited, cached, and monitored
- The architecture scales by adding middleware to the public router (CDN, edge caching)

### Negative
- Two parallel Express middleware stacks to maintain and test
- SSR for public pages introduces a rendering path that must be built and maintained
- The SPA catch-all must be updated to exclude `/public/*` paths
- CDN configuration must differentiate between cacheable (`/public/*`) and non-cacheable (`/api/v1/*`) paths

### Compliance and Security Implications
- Public route handlers must never import tenant-scoped repositories or services
- The `anonScoringService` is the only data access layer for public routes — it uses the scoring engine directly without persisting to tenant tables
- All public responses must be audited to ensure no `tenant_id`, email, or portfolio data is included
- Rate limiting on public routes uses a separate token bucket (per-IP) from authenticated routes (per-tenant)
- Cache entries must not include sensitive data — cache keys and stored values are audited

### Migration and Monitoring Plan
1. Implement the public router scaffold with rate limiter and cache middleware (empty route set).
2. Add Feature B endpoints (`/public/s/:slug`, `/public/s/:slug/og.png`) behind the public router.
3. Add Feature C endpoints (`/public/domain/:name`, `/public/compare/:slug`, `/sitemap.xml`).
4. Update the SPA catch-all in `src/index.ts` to exclude `/public/*`.
5. Deploy and monitor: cache hit ratio, rate limit events, error rate on public routes.
6. Rollback: remove the `app.use('/public', publicRouter)` line — all public routes become 404 instantly with no impact on authenticated routes.

### Validation
- Integration tests verify that public route responses contain no `tenant_id` field
- Integration tests verify that authenticated middleware never executes for `/public/*` requests
- Load tests verify that public rate limiting protects the scoring engine from abuse
- Cache hit ratio >80% on `/public/*` within 30 days of Feature C launch
- SEO pages pass Google Rich Results test with valid JSON-LD

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`.*
