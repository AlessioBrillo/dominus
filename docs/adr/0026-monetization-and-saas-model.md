# ADR-0026: Monetization and SaaS Model

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-06-18 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | ADR-0001 (partial — revises "single-user" constraint) |
| **Relates to** | ADR-0025, ADR-0027, ADR-0028 |
| **Project** | DOMINUS |

## Context

DOMINUS was conceived as a personal decision-support tool for a single operator. ADR-0001 explicitly states: *"single user, tens to low hundreds of domains. No multi-tenancy, no concurrent access, no horizontal scaling requirement."* The infrastructure decisions (SQLite, single-process, env-var API keys) all flowed from this premise.

Two factors motivate a fundamental revision of this constraint:

1. **Commercial opportunity**: The domain investment market has thousands of participants, most relying on gut feel or expensive commercial appraisals. A tool that delivers transparent, heuristic, zero-cost-at-core scoring has clear product-market fit. Offering it as a managed SaaS (DOMINUS Cloud) creates a sustainable revenue stream without charging for the software itself.

2. **Open-source sustainability**: The AGPL v3 + commercial model (ADR-0025) enables the project to generate revenue while remaining genuinely open source. Without a monetisation strategy, the project remains a hobby — unable to fund ongoing development, infrastructure, or community support.

This ADR defines what is monetised and what remains free, ensuring the open-source community edition never becomes a crippled demo.

## Decision Drivers

1. **Community edition is fully functional** — The AGPL-licensed community edition must never be artificially limited. Every feature that exists today must remain in the community edition forever. Monetisation is on infrastructure, convenience, and enterprise compliance — not on feature gating.

2. **Zero-cost API principle preserved (ADR-0018)** — The tool itself never requires a paid subscription to function. All external data sources remain free or file-based. No feature in the community edition calls a paid API. This principle is non-negotiable.

3. **Clear upgrade path** — Users should understand exactly what they get by paying. The free tier (if any) of DOMINUS Cloud should be generous enough to be genuinely useful. Paid tiers add capacity, team features, and support — not basic functionality.

4. **Revenue without vendor lock-in** — No user data is trapped in a proprietary format. The community edition reads and writes the same database schemas. A paying customer can export their data and self-host at any time with zero friction.

5. **Simple pricing** — Single-developer project: complex tier structures, usage metering per API call, and per-seat pricing create support overhead that a solo founder cannot sustain. Pricing must be simple enough to communicate in one sentence.

## Considered Options

### Option A: Donation-Ware / Sponsorship Only

Keep the tool free (MIT as before) and rely on GitHub Sponsors, PayPal donations, or Open Collective contributions.

**Advantages:**
- Zero business complexity — no billing, no tiers, no subscription management
- Maximum community goodwill — no perception of "selling out"
- No legal overhead for commercial licensing

**Disadvantages:**
- Donations are unpredictable and, for domain-tool niches, rarely reach sustainability levels
- A single-developer project with significant ongoing development costs (infrastructure, domain research data, legal) cannot rely on goodwill economics
- No budget for marketing, UX improvements, or paid advertising to grow the user base
- The project remains a hobby that could be abandoned when the developer loses interest or faces real-world financial pressures

**Cost Implications:** Zero operational cost. Revenue: €0-500/year (typical for niche open-source sponsorships).

**Risk Assessment:** High. Donation models work for projects with corporate sponsors (Webpack, Babel) or massive communities (Vue, React). A domain-investment tool has neither.

---

### Option B: Open Core — Community (AGPL) + Enterprise (Paid)

Release the community edition under AGPL v3 with all current functionality. Offer a paid Enterprise edition that adds features not available in the community edition (advanced analytics, team collaboration, SSO, priority support).

**Advantages:**
- Clear monetisation path: enterprise features justify the price
- Proven model (GitLab, Mattermost, N8N)
- Self-hosted Enterprise edition available for companies that cannot use SaaS

**Disadvantages:**
- Feature gating creates community resentment if done aggressively
- The line between "community" and "enterprise" features is subjective and contentious
- Requires maintaining two feature sets, increasing test surface and support burden
- Community edition users see the enterprise feature list as a set of things deliberately withheld — eroding trust
- ADR-0018 (zero-cost principle) becomes harder to explain if enterprise features connect to paid APIs
- High support burden for a solo maintainer

**Cost Implications:** ~20h/month overhead for maintaining two feature tracks. Legal costs for enterprise license agreement. Billing infrastructure.

**Risk Assessment:** Medium-high. Feature gating alienates the community that open-source projects depend on for contributions and advocacy. For a solo developer, the support burden of maintaining parallel feature sets is significant.

---

### Option C: SaaS-Hosted Only — Free Tier + Paid Tiers (CHOSEN)

Keep the AGPL community edition identical to the paid version in features. Monetise exclusively through DOMINUS Cloud — the hosted service. The community edition is self-hosted only. DOMINUS Cloud adds:

- **Multi-tenancy**: managed user accounts, team collaboration, tenant isolation
- **PostgreSQL**: managed database with automated backups, point-in-time recovery
- **Managed infrastructure**: uptime monitoring, automated updates, DDoS protection
- **Priority support**: email/Slack response within 4 hours for paid plans
- **Higher rate limits**: more pipeline runs per day, more API calls per hour

The community edition retains:
- All scoring, pipeline, portfolio, trademark, backtest features — identical code
- SQLite (single-user default) with PostgreSQL adapter available for self-hosters who want it
- All CLI commands and all API endpoints
- Unlimited pipeline runs, unlimited domains, unlimited API calls
- File-based keyword and comps data (no paid API requirement)

**Advantages:**
- **Zero feature gating**: the community edition is identical to what runs on DOMINUS Cloud. No one can accuse the project of "crippling" the open-source version.
- **Self-hosting is always free**: any user can run the identical software on their own infrastructure at zero cost. This is the strongest possible trust signal.
- **Simple pricing**: capacity-based tiers (runs/day, domains, team seats) are easy to understand and communicate.
- **No lock-in**: export from DOMINUS Cloud and self-host with a single database dump + `.env` file.
- **ADR-0018 preserved**: the tool itself never requires a paid subscription — only the managed hosting does.
- **Lower maintenance**: one codebase, no feature branching, no dual-track testing.

**Disadvantages:**
- Revenue is tied to hosting margin: DOMINUS Cloud must compete on price and quality with self-hosting. Users who are technical enough to self-host will do so — they are not the target market.
- The community edition has all features, so there is no artificial "upgrade pressure." Users must be convinced that paying for hosting is worth it (backups, uptime, convenience).
- Infrastructure costs are uncorrelated with revenue in the short term: the first 100 free-tier users cost as much to host as the first 100 paid users.

**Cost Implications:** ~€50-200/month infrastructure cost at expected scale (single VPS, PostgreSQL, object storage). Billing overhead: Stripe 2.9% + €0.29 per transaction. No additional development overhead beyond the community edition itself.

**Risk Assessment:** Low-medium. The model relies on the hosting value proposition rather than artificial scarcity. It aligns with the project's values and is the most defensible against community criticism.

---

### Option D: Fully Hosted (No Self-Host Option)

Make DOMINUS SaaS-only. The open-source repository becomes a reference/development version only, not intended for production self-hosting.

**Advantages:**
- Full control over the user experience and infrastructure
- No need to support multiple deployment configurations
- Higher conversion rate (users cannot self-host)

**Disadvantages:**
- Violates the project's open-source principles — the repo becomes a demo, not a product
- Aligns poorly with ADR-0018 and the project's stated values
- Creates a strong incentive for forks
- Community trust damage would be significant and likely irreparable

**Cost Implications:** Same as Option C.

**Risk Assessment:** High. This option contradicts the open-source architecture (ADR-0018) and would be perceived as a bait-and-switch after MIT development. Rejected by principle.

---

## Decision

**Chosen option: Option C — SaaS-Hosted Only (Free Tier + Paid Tiers)**

The rationale:

1. **Zero feature gating**: Every feature that exists in the community edition is identical to what runs on DOMINUS Cloud. The only difference is infrastructure — managed multi-tenancy, PostgreSQL, backups, and support. This is the strongest trust signal an open-source SaaS can offer.

2. **ADR-0018 compatibility**: The tool itself never requires a paid subscription. Every external API is free or file-based. Users who self-host have the identical experience. Only the managed hosting is monetised.

3. **No lock-in**: A user can migrate from DOMINUS Cloud to self-hosted (or another provider) with a database dump. The community edition reads the same schema. This freedom is non-negotiable for an open-source project.

4. **Simple to operate**: One codebase, one feature set, one test suite. No enterprise branch, no feature flags for paid tiers, no dual-track maintenance. This is critical for a solo maintainer.

5. **Proven precedent**: Supabase, Gitpod, and countless others have validated that developers will pay for managed hosting of software they could self-host, as long as the value proposition (backups, uptime, convenience) is clear.

### Pricing Model

Suggested structure (to be validated with early users):

| Tier | Price | Runs/day | Team seats | Support |
|------|-------|----------|------------|---------|
| **Free** | €0 | 10 | 1 (solo) | Community (GitHub Issues) |
| **Pro** | €19/mo | 100 | 3 | Email (4h response) |
| **Team** | €49/mo | 500 | 10 | Email + Slack (2h response) |
| **Enterprise** | Custom | Unlimited | Unlimited | SLA, SSO, dedicated infra |

The community edition (self-hosted) has no limits — unlimited runs, unlimited domains, all features. The tiers apply only to DOMINUS Cloud hosted accounts.

## Consequences

### Positive
- Community edition is never gated or reduced — full trust with the open-source audience
- SaaS revenue funds ongoing development, infrastructure, and community support
- Users can self-host forever at zero cost — migration is a database dump away
- Simple operations: one codebase, one feature set, one test suite
- Clear upgrade path: capacity tiers that directly correspond to infrastructure cost
- Free tier serves as a "try before you self-host" for technical users and a "use forever" for casual users

### Negative
- Revenue per user is lower than feature-gated models (users only pay for hosting, not software)
- Infrastructure cost per free-tier user is borne by the project — requires careful monitoring
- Some users will self-host forever and never convert — this is accepted by design
- Support burden for free-tier users must be managed carefully to avoid overwhelming a solo maintainer

### Compliance and Security Implications
- DOMINUS Cloud must comply with GDPR (user data in EU region by default)
- Data processing agreement (DPA) required for EU-entity customers
- SOC2 compliance is deferred to the Enterprise tier (too costly for a solo founder at current scale)
- No user data is mined, sold, or used for training — this is a hard policy

### Migration and Monitoring Plan
- **Phase 1 (v0.4.0)**: Prepare architecture for multi-tenancy (ADR-0027). Community edition remains SQLite + single-user.
- **Phase 2 (v0.5.0)**: DOMINUS Cloud MVP — PostgreSQL, auth, first paid tier. Community edition remains identical.
- **Phase 3 (v0.6.0)**: Team tier, admin panel, usage metering. Validate pricing with early customers.
- **Validation metrics**: Free-to-paid conversion rate, self-host adoption, churn rate, support ticket volume per tier.

### Validation
- Free tier signups within 90 days of launch (target: 100+)
- Paid conversion rate ≥5% within 180 days
- Self-host community edition downloads ≥ SaaS signups (indicator that the community edition is genuinely useful)
- NPS survey at 6 months post-launch

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`.*
