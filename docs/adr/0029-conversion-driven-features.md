# ADR-0029: Conversion-Driven Features for DOMINUS Cloud

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-06-21 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0026, ADR-0027, ADR-0018, ADR-0030 |
| **Project** | DOMINUS |

## Context

DOMINUS is transitioning from a single-user tool to a managed SaaS (DOMINUS Cloud) under the monetisation model defined in ADR-0026. The community edition remains fully functional under AGPL v3 — every feature in the Cloud is also present in the self-hosted version. Revenue comes from managed hosting, not feature gating.

This creates a conversion problem: users who discover DOMINUS through the GitHub repository, search engines, or community referrals must experience enough value in the free Cloud tier to justify upgrading to a paid plan. Without deliberate conversion mechanics in the product itself, the funnel leaks at every stage.

Three conversion challenges are identified:

1. **Time-to-value**: A new signup lands on an empty dashboard with no data, no scores, no context. The perceived effort to configure the tool outweighs the perceived value. Industry benchmarks (micro-SaaS, B2B tools) show that activation within the first 7 minutes is the strongest predictor of paid conversion.

2. **Viral loop**: Domain investors already share appraisal screenshots (Estibot, DomainIQ) in negotiation threads on NamePros, X, and domain forums. DOMINUS has no shareable surface — every score is locked behind authentication. This is a free growth channel left unexploited.

3. **Organic acquisition**: Competitors (Estibot, GoDaddy Appraisal) capture significant organic traffic through pages like "value of X.com". DOMINUS has zero public-facing pages and zero search-engine-optimised content. The cost of creating these pages is near-zero (the scoring engine runs on free data per ADR-0018), making SEO a high-ROI channel.

These three problems share a common architectural gap: DOMINUS currently has **no public, unauthenticated surface**. Every endpoint is behind `/api/v1/*` with authentication middleware. Introducing public pages requires careful design to avoid data leakage between tenants and to preserve the zero-cost principle.

## Decision Drivers

1. **Activation rate** — The free-to-paid conversion funnel depends on users reaching the "aha moment" (seeing a keep/drop verdict on their own portfolio with quantified savings) within minutes of signup. Every additional step before activation reduces conversion.

2. **Viral loop economics** — Shareable score pages create a free growth channel: each shared page is an impression, a backlink, and a potential signup. The marginal cost is zero (scoring engine, free trademark data). Not building this leaves a compounding growth asset on the table.

3. **Organic acquisition cost** — Programmatic SEO pages have a high upfront investment (architecture, rendering, caching) but near-zero marginal cost and compounding returns over months. For a solo-founder SaaS with no marketing budget, this is the highest-ROI acquisition channel available.

4. **Tenant isolation integrity** — Introducing public endpoints into a multi-tenant architecture with Row-Level Security (ADR-0027) creates a risk of cross-tenant data exposure. The public surface must be architecturally isolated from the authenticated tenant-scoped surface.

5. **Zero-cost principle preserved** — Per ADR-0018, the community edition must never require a paid API call. Public scoring (for shareable pages and SEO) must use only the same free data sources (public RDAP, USPTO, EUIPO, file-based keyword/comps) that the authenticated pipeline uses. No paid API may be introduced for public features.

## Considered Options

### Option A: No Conversion Features — Build Cloud Infra Only

Ship DOMINUS Cloud with just the multi-tenant infrastructure (PostgreSQL, auth, team accounts) and rely on the GitHub README and community word-of-mouth for user acquisition.

**Advantages:**
- Zero additional engineering time — focus entirely on infra reliability
- No risk of implementing features that don't move the conversion needle
- Simpler security surface — no public endpoints to protect

**Disadvantages:**
- Empty dashboard on first signup = immediate churn for non-technical users
- No viral loop — every user acquired must come through direct channels (GitHub, forums, paid ads)
- No organic search presence — competitors capture all domain-valuation search traffic
- The community edition already exists as a "try before you buy" — the Cloud needs a better hook

**Cost Implications:** €0 development cost. Opportunity cost of lost conversions: estimated 60-80% lower free-to-paid conversion rate based on micro-SaaS benchmarks.

**Risk Assessment:** High. Without conversion mechanics, the Cloud launch is unlikely to reach the 5% free-to-paid conversion target defined in ADR-0026. The solo-founder has no marketing budget to compensate with paid acquisition.

---

### Option B: Third-Party Integration Approach

Integrate a third-party appraisal widget (e.g., Estibot API) for public score pages, use a SaaS onboarding tool (Appcues, Userflow) for the signup wizard, and rely on a prerendering service (Prerender.io) for SEO.

**Advantages:**
- Faster time-to-market for each individual feature
- Specialised tools may have better UX than a custom implementation
- Prerender.io handles the SSR complexity for SEO pages

**Disadvantages:**
- Contradicts ADR-0018 (zero-cost principle) — Estibot API costs money per query
- Third-party onboarding tools introduce vendor lock-in for the signup flow
- Prerender.io adds latency and a monthly cost (€30-100/mo at scale)
- Data leakage risk: sending domain data to third-party appraisal APIs
- Each integration adds a potential point of failure for the signup flow

**Cost Implications:** €50-200/month in third-party services at launch scale. Vendor lock-in risk for the onboarding flow.

**Risk Assessment:** Medium-high. The third-party appraisal dependency directly contradicts the project's core values (transparency, zero-cost, open-source). The onboarding and prerendering tools add monthly costs that erode the slim margins of a micro-SaaS.

---

### Option C: Custom Conversion Features with Public Namespace (CHOSEN)

Build three conversion features natively, using the existing scoring engine, and isolate the public surface behind a dedicated `/public/*` namespace with separate rate limiting, caching, and no tenant context.

**Advantages:**
- Full control over the conversion funnel — every step is measurable and optimisable
- Zero additional API cost — scoring engine already uses free data (ADR-0018)
- No vendor lock-in — the conversion layer is part of the open-source codebase
- The public namespace architecture is reusable for future features (API marketplace, public portfolio snapshots)
- Self-hosters get these features too (per ADR-0026 community-first principle)

**Disadvantages:**
- Higher upfront engineering investment (estimated 2-3 weeks for all three features)
- Public endpoint security requires careful design and testing
- SSR for SEO pages adds architecture complexity beyond the current SPA-only frontend
- The public score snapshot introduces a new table and cache invalidation concern

**Cost Implications:** ~80-120h development. €0 additional monthly operating cost (scoring engine uses free data). CDN costs at scale: negligible for the first 10k daily pageviews.

**Risk Assessment:** Low. The scoring engine and trademark gate are already implemented and tested. The public namespace is a routing concern, not a fundamental architecture change. The SSR requirement is the highest-risk component — mitigated by limiting SSR to only the public namespace (the authenticated app remains a SPA).

---

### Option D: Hybrid — Custom Features, No Public Namespace

Build the three conversion features but serve them through the existing authenticated API, using a single "guest" tenant for unauthenticated users.

**Advantages:**
- No new namespace — reuse existing auth middleware and tenant resolution
- Simpler routing — no changes to the SPA catch-all or server configuration
- Faster to implement than Option C

**Disadvantages:**
- A "guest tenant" pattern is fragile — a bug in tenant resolution could expose data from other tenants
- Rate limiting is shared with authenticated users — a SEO crawl could starve real users of API capacity
- The guest tenant would need special-case handling in every repository query
- Not compatible with the RLS model defined in ADR-0027 (a guest tenant_id would exist in every row)
- Cross-tenant data exposure risk is real and hard to test exhaustively

**Cost Implications:** ~40-60h development. Lower upfront but higher maintenance and audit cost.

**Risk Assessment:** High. The guest-tenant pattern introduces an unacceptable risk of cross-tenant data exposure. It creates a special case that must be handled in every repository query, every middleware, and every RLS policy. One oversight could leak portfolio data.

---

## Decision

**Chosen option: Option C — Custom Conversion Features with Public Namespace**

The rationale:

1. **Architectural integrity**: A dedicated `/public/*` namespace with no auth middleware, no tenant context, and no access to tenant-scoped tables is the only design that guarantees tenant isolation. The boundary is enforced at the router level, not in application logic. This is consistent with the defence-in-depth principle established in ADR-0027 (RLS is the safety net, not the only barrier).

2. **Zero-cost preservation**: The public namespace uses the same `AnonScoringService` — a wrapper around the existing scoring engine that operates in "no-persist" mode. No paid API is introduced. Self-hosters can enable public pages at no additional cost (they control their own CDN and domain).

3. **Community edition parity**: Per ADR-0026, no feature is exclusive to the Cloud. All three conversion features are AGPL-licensed and part of the open-source repository. Self-hosters who want public score pages or programmatic SEO can enable them — the Cloud's value is managed infra, CDN, and SEO authority, not feature exclusivity.

4. **Compounding ROI**: The three features form a funnel: onboarding (conversion of existing traffic) → shareable scores (viral loop) → SEO (compounding organic acquisition). Each feature amplifies the others. The engineering investment is front-loaded but the marginal cost per user acquired trends to zero.

5. **Rejecting Option D (guest tenant)**: A single misrouted query in a guest-tenant architecture could expose portfolio data. This risk is unacceptable for a tool whose core value proposition includes trademark risk assessment and portfolio management — the very data that would be most damaging if leaked. The explicit namespace boundary of Option C eliminates this risk class entirely.

The detailed architecture of the public namespace is defined in ADR-0030.

## Consequences

### Positive
- Three compounding growth channels built into the product with zero marginal cost per user
- Tenant isolation is enforced at the architectural level (separate router), not in application logic
- Self-hosters get the same features — consistent with the community-first principle (ADR-0026)
- The public namespace is reusable for future features (public portfolio snapshots, embedded score widgets)
- Conversion funnel is fully instrumentable via the self-hosted events table

### Negative
- ~80-120h of engineering time for the three features before the Cloud launch
- SSR for public pages adds a rendering layer that the current SPA-only architecture does not need
- The public namespace must be maintained as a parallel surface — cache configuration, rate limit tuning, CDN integration
- OG image generation for shareable scores requires a new rendering dependency (@vercel/og, satori, or canvas)

### Compliance and Security Implications
- The `/public/*` namespace must never expose `tenant_id`, email, portfolio data, or any user-identifiable information
- Public score snapshots are immutable — once created, they cannot be retroactively linked to a tenant's portfolio
- Rate limiting on public endpoints must prevent abuse (scraping, DoS) without blocking legitimate organic traffic
- GDPR considerations: public score pages containing domain names are not personal data, but the analytics events table must respect opt-out mechanisms
- Robots.txt and sitemap.xml must be managed to avoid indexing of sensitive or internal pages

### Migration and Monitoring Plan
1. **Phase 1 (v0.8.0)**: Feature A — onboarding wizard. Implement sample-run, portfolio import with savings callout, wizard state persistence. This converts existing traffic and has the highest immediate ROI.
2. **Phase 2 (v0.9.0)**: Feature B — shareable score pages. Implement `/public/*` namespace, public_scores table, share endpoint, OG image generation. This creates the viral loop.
3. **Phase 3 (v1.0.0)**: Feature C — programmatic SEO. Implement anon scoring, public domain score pages, sitemap, comparison content. This is the slow-burn compounding channel.
4. **Monitoring metrics**: Activation rate (time_to_activation < 7 min), share-to-signup rate, organic-to-signup rate, cache hit ratio on `/public/*` (>80% target).

### Validation
- Feature A: `time_to_activation` tracked via events table. Target: < 7 min for 50th percentile within 30 days of launch.
- Feature B: `share_to_signup_rate` tracked via UTM parameters on CTA links. Target: ≥ 2% within 90 days.
- Feature C: Organic sessions tracked via Search Console + self-hosted analytics. Target: ≥ 500 organic sessions/month within 6 months.
- All three features must pass security audit: no tenant data leakage in any public response (verified with integration tests).
- Cache hit ratio on `/public/*` must exceed 80% within 30 days of Feature C launch.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`.*
