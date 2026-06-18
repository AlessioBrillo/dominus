# ADR-0025: License Change — MIT to AGPL v3 + Commercial

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-06-18 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | ADR-0018 (partial — clarifies licensing terms) |
| **Relates to** | ADR-0001, ADR-0026, ADR-0027 |
| **Project** | DOMINUS |

## Context

DOMINUS launched under the MIT license — a permissive, zero-restriction license that maximises adoption, forking, and community contribution. This was the correct choice for v0.x: it removed every barrier to entry and signalled that the project is genuinely open.

As the project matures toward a commercial SaaS offering (DOMINUS Cloud), a tension emerges:

1. **MIT allows anyone to offer an identical SaaS** — A competitor can clone the repo, add a Stripe subscription, and compete directly with DOMINUS Cloud using the same codebase, with no obligation to contribute improvements back. The copyright holder (the sole author) has no competitive advantage beyond being first to market.

2. **The scoring engine is the core asset** — The heuristic valuator (intrinsic, commercial, market, expiry signals) represents months of tuning, backtesting, and domain expertise. MIT allows a competitor to embed this engine in a proprietary product and never publish their modifications.

3. **SaaS infrastructure is a differentiator** — The value of DOMINUS Cloud is not just the code but the managed infrastructure (PostgreSQL, monitoring, uptime, support). A permissive license that allows competitors to replicate the identical service at lower cost (no R&D amortisation) undermines the business model.

4. **Existing forks are unaffected** — Code already distributed under MIT remains MIT forever. The license change applies only to new versions of the project after the transition date.

The AGPL v3 license was designed specifically for this scenario. It is a true open-source license (OSI-approved) that preserves all four essential freedoms (use, study, share, modify) while adding a network-use provision: anyone who modifies the software and offers it as a network service must release their modifications under the same license.

## Decision Drivers

1. **Open-source integrity** — The license must be OSI-approved and recognised as true open source. Source-available licenses (BSL, SSPL, Commons Clause) are not acceptable — they erode trust and community goodwill.

2. **SaaS competitor protection** — A competitor who clones the repo and offers an identical cloud service must publish their modifications under the same license, preserving DOMINUS's competitive moat.

3. **Commercial viability** — The license must allow the copyright holder to offer a paid SaaS (DOMINUS Cloud) and a paid commercial license for enterprises that cannot or will not comply with AGPL terms.

4. **Backward compatibility** — Existing MIT-licensed distributions, forks, and npm packages are not retroactively affected. The change applies only to new versions.

5. **Community contribution** — The license transition must not deter contributors. A Contributor License Agreement (CLA) will ensure the project retains the right to relicense contributed code.

## Considered Options

### Option A: Remain MIT (Status Quo)

Keep the MIT license unchanged. DOMINUS remains maximally permissive.

**Advantages:**
- No friction for existing users and contributors — zero license confusion
- Maximum adoption by enterprises (MIT is the gold standard for permissive licensing)
- No need for a CLA or contributor agreement
- No legal costs for license enforcement

**Disadvantages:**
- Zero protection against SaaS competitors — anyone can clone and host a competing service
- No ability to offer a differentiated commercial license for embedded use
- The scoring engine — months of tuning and domain expertise — becomes a commodity available to every competitor
- The business model relies entirely on brand loyalty and being first to market

**Cost Implications:** Zero legal cost. Full revenue risk from SaaS competition.

**Risk Assessment:** High business risk. The single-developer project has no marketing budget to compete on brand alone. A well-funded competitor could clone the repo, launch a competing SaaS with better UX, and capture the market before DOMINUS Cloud establishes itself.

---

### Option B: AGPL v3 Only

Switch to AGPL v3 without offering a commercial license.

**Advantages:**
- Full protection against SaaS competitors (network-use provision)
- True open source (OSI-approved), preserving community trust
- Maximum community protections — all modifications must flow back

**Disadvantages:**
- Some enterprises prohibit AGPL dependencies in their legal policies (less common than GPL fear, but still a barrier)
- No revenue stream from commercial licensing — only SaaS subscriptions
- Users who want to embed DOMINUS in proprietary products cannot do so legally
- May reduce contribution volume from corporate developers whose legal teams block AGPL

**Cost Implications:** Zero legal cost. Some enterprise adoption friction.

**Risk Assessment:** Medium. AGPL adoption barriers are lower than they were a decade ago. Grafana, Element, and MinIO have proven AGPL can work for successful open-source businesses.

---

### Option C: AGPL v3 + Commercial License (CHOSEN)

Switch to AGPL v3 for all community distribution and offer a paid commercial license for enterprises that need proprietary embedding.

**Advantages:**
- AGPL's network-use clause protects against SaaS competitors
- Commercial license creates an additional revenue stream (enterprise sales)
- Enterprises that cannot adopt AGPL have a clear path: buy a commercial license
- Proven model (Grafana, Element, MinIO, MongoDB before SSPL)
- The community edition remains fully functional — no feature gating in the AGPL version
- Commercial license terms are flexible (per-seat, per-instance, OEM, or flat annual fee)

**Disadvantages:**
- Requires legal infrastructure: license agreement text, sales process, invoice handling
- CLA is mandatory for accepting contributions (to relicense contributed code under both AGPL and commercial terms)
- More complex messaging: "AGPL v3 with commercial option" takes more explanation than "MIT"
- Small additional friction for enterprise adoption (they can buy a license, but it costs money)

**Cost Implications:** Legal review for commercial license text (~€500-1500 one-time). Ongoing administrative overhead for license sales (minimal at expected scale).

**Risk Assessment:** Low. The AGPL + commercial model is well-established, legally tested, and widely understood in the open-source ecosystem.

---

### Option D: Dual License — MIT for Community, Commercial for Enterprise

Keep the existing code under MIT and offer a separate commercial license that adds additional rights (warranty, indemnification, support SLA).

**Advantages:**
- Existing code remains MIT with zero change
- Commercial license can be an "enhanced" offering rather than a constraint

**Disadvantages:**
- MIT allows competing SaaS — the core problem remains unsolved
- The commercial license adds no competitive protection, only optional services
- Harder to justify the commercial license when the MIT version is functionally identical

**Cost Implications:** Same as Option C, but with no competitive moat.

**Risk Assessment:** High. This option addresses none of the competitive concerns that motivated this ADR.

---

## Decision

**Chosen option: Option C — AGPL v3 + Commercial License**

The rationale:

1. **SaaS protection**: AGPL v3's network-use clause ensures that anyone offering a modified DOMINUS as a cloud service must publish their modifications. This prevents a competitor from taking the codebase, adding proprietary improvements, and competing with DOMINUS Cloud without contributing back. Unmodified forks running the vanilla AGPL code remain allowed — but they gain no competitive advantage from their own enhancements.

2. **Commercial viability**: The commercial license creates a second revenue stream alongside SaaS subscriptions. Enterprise customers who need to embed the scoring engine in a proprietary product, or whose legal policies prohibit AGPL, can purchase a commercial license. The pricing is decoupled from the SaaS subscription.

3. **Open-source integrity**: AGPL v3 is OSI-approved. Every freedom defined by the Open Source Initiative is preserved. The project remains genuinely open source — unlike source-available licenses (BSL, SSPL, Commons Clause) that erode community trust.

4. **Proven model**: Grafana ($6B+ valuation), Element, MinIO, and countless others have validated the AGPL + commercial model. The community understands it. The legal infrastructure exists. No new ground is being broken.

5. **Backward compatibility**: Code already distributed under MIT (v0.1.0 through v0.3.0) remains MIT forever. The transition applies to v0.4.0 and later. Existing forks are unaffected.

### Transition Plan

1. **v0.3.x (current)**: Final MIT release. The LICENSE file and README still reference MIT.
2. **v0.4.0**: First AGPL v3 release. LICENSE file is replaced with AGPL v3 text. README is updated. A COMMERCIAL_LICENSE.md file is added.
3. **Contributor License Agreement (CLA)**: Effective from v0.4.0 onward. All contributors must sign a CLA granting the project the right to relicense their contributions under both AGPL v3 and commercial terms.

## Consequences

### Positive
- **Competitive moat**: A competitor cannot clone DOMINUS and offer a proprietary SaaS; they must open their modifications under AGPL
- **Dual revenue**: SaaS subscriptions + commercial licenses create independent revenue streams
- **Community trust preserved**: AGPL is OSI-approved open source — the project remains genuinely free
- **Enterprise path**: Companies blocked by AGPL have a clear, paid path to compliance via commercial license
- **CLA protects flexibility**: The project retains full control over licensing without needing to hunt down contributors for permission

### Negative
- **Friction for corporate contributors**: Some developers at AGPL-averse companies cannot contribute. Mitigation: the CLA allows contributing under both AGPL and commercial terms, which most companies accept.
- **Messaging complexity**: "AGPL v3 with commercial option" requires more explanation than "MIT." The README must clearly explain why this choice was made and what it means for different user segments.
- **Legal overhead**: Commercial license sales require legal text, invoicing, and basic compliance verification. At expected scale this is manageable as a solo founder.

### Compliance and Security Implications
- AGPL v3 requires that modified versions distributed as network services include source code access. DOMINUS Cloud, operated by the copyright holder, is exempt from this requirement (the copyright holder needs no license to use their own code).
- Commercial license customers receive a standard enterprise license agreement with warranty disclaimers, indemnification, and term limits.
- The LICENSE file must be updated to AGPL v3 text. `package.json` `license` field must change to `"AGPL-3.0-only"`.
- SPDX identifiers in source files should be updated from `MIT` to `AGPL-3.0-only`.

### Migration and Monitoring Plan
- **Phase 1 (v0.4.0-alpha.1)**: Replace LICENSE file, update package.json, update README badges and references
- **Phase 2 (v0.4.0-alpha.2)**: Add COMMERCIAL_LICENSE.md with standard terms (per-instance annual, per-developer annual, OEM flat fee)
- **Phase 3 (v0.4.0)**: Official AGPL v3 release with full documentation, CLA integration in contribution workflow, and first commercial license availability
- **Rollback**: If the license change causes significant adoption or contribution issues, revert to MIT. However, this is considered unlikely given the successful precedents.

### Validation
- Community feedback during alpha releases (v0.4.0-alpha.x) will surface adoption friction
- Number of commercial license inquiries and conversions within 90 days of v0.4.0
- Pull request volume before vs. after the license change (indicator of contributor friction)
- No decrease in GitHub stars, forks, or npm downloads compared to the MIT era

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`.*
