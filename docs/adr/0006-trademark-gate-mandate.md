# ADR-0006: Trademark Gate Mandate

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted (retrospective) |
| **Date** | 2026-06-08 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0003, ADR-0004, ADR-0012, ADR-0014 |
| **Project** | DOMINUS |

## Context

Domain aftermarket investment carries legal risk. Registering or purchasing a
domain that infringes a registered trademark exposes the operator to:

1. **UDRP proceedings**: the trademark holder files a Uniform Domain Name
   Dispute Resolution Policy complaint. The operator risks losing the domain
   and paying legal fees.
2. **ACPA lawsuits**: in the US, the Anti-Cybersquatting Consumer Protection
   Act provides for statutory damages of $1,000–$100,000 per domain.
3. **Registry suspension**: some TLD registries (notably `.us` and `.eu`) will
   suspend domains on receipt of a court order or registrar notice of
   trademark infringement.

For a budget-constrained operator (~500 EUR), a single UDRP filing or ACPA
lawsuit would exceed the entire annual budget. The legal risk of trademark
infringement is asymmetric: the cost of checking is near-zero (free USPTO and
EUIPO APIs), while the cost of not checking could be catastrophic.

The trademark gate is therefore non-negotiable: no candidate reaches a buy
recommendation without passing it. This principle is enforced at the
architecture level, not just as a convention.

## Decision Drivers

1. **Asymmetric risk** — the cost of a trademark lookup is near-zero (free
   APIs, sub-second per domain), while the cost of a missed infringement is
   potentially thousands of EUR in legal fees + domain loss.
2. **Non-bypassability** — the trademark gate must be mandatory and
   unskippable. No flag like `--skip-trademark` may exist. The architecture
   must make bypassing the gate impossible without modifying the orchestrator
   code.
3. **Two-jurisdiction coverage** — USPTO (US trademarks) and EUIPO (EU
   trademarks) are the minimum. WIPO global registration is desirable but
   not essential for the initial implementation.
4. **Graceful degradation** — if the USPTO or EUIPO API is unavailable, the
   gate must produce an "Unverified" verdict, never a "Clear" verdict. An
   API error must not result in a buy recommendation.
5. **Rate-limit awareness** — free APIs are rate-limited. The gate must
   preserve API calls by checking scoring recommendations first (only
   score-recommended domains go through the gate) and by caching results.

## Considered Options

### Option A: Mandatory Gate — Runs Last, Caching + Retry (CHOSEN)

The trademark gate is the fifth and final stage of the pipeline, running after
the scoring engine. It receives only candidates that the scoring engine
recommended for purchase, preserving rate-limited API calls. The gate supports
multiple providers (USPTO + EUIPO), results caching (7-day TTL), and
transient error retry (3 attempts with exponential backoff + jitter).

The verdict is one of:
- `Clear` — no conflicting mark found. Candidate proceeds to buy recommendation.
- `Blocked` — conflicting mark found. Candidate is rejected.
- `Unverified` — provider error or unavailable. Candidate is treated as
  blocked (no recommendation) but marked for manual review.

**Advantages:**
- Non-bypassable by design: the `TrademarkGateStage` is one of five mandatory
  stages in the orchestrator. Removing it requires editing `src/index.ts`.
- Caching (CachedTrademarkProvider) avoids repeat API calls for the same
  search term within the TTL window.
- Retry (RetryingTrademarkProvider) handles transient failures from free APIs.
- The "Unverified" verdict guarantees conservatism: an API error never
  produces a buy recommendation.

**Disadvantages:**
- Adds 1-3 seconds per recommended candidate (two API calls: USPTO + EUIPO).
  Mitigated by caching (most terms are checked once per 7 days).
- EUIPO requires OAuth2 credentials (free), which adds a setup step for the
  operator.
- Token-aware matching (ADR-0012) is algorithmically more complex than simple
  substring match, adding ~200 lines of matching logic.

**Cost Implications:** Zero monetary cost. USPTO is a free public API (no key
required). EUIPO registration is free at
`https://euipo.europa.eu/ohimportal/en/open-data`.

**Risk Assessment:** Low. Both APIs are stable and well-documented. The
`Unverified` verdict ensures safety even during provider outages.

---

### Option B: Optional Gate with --skip-trademark Flag (REJECTED)

The trademark gate exists but can be bypassed via a CLI flag or API parameter.

**Advantages:**
- Faster pipeline execution when the operator is confident a candidate has no
  trademark risk.
- Useful for initial testing and weight tuning without waiting for TM checks.

**Disadvantages:**
- A single "I'll skip it just this once" decision could lead to a UDRP filing
  that costs thousands of EUR.
- Architectural inconsistency: the pipeline has five mandatory stages, except
  when it doesn't. The orchestrator would need branching logic.
- The `--skip-trademark` flag would need to be removed before the first real
  purchase, but nothing enforces that removal.

**Cost Implications:** Zero monetary cost. Lower up-front, but the potential
liability cost is unbounded.

**Risk Assessment:** High. The human factor (skip the check "just once")
combines with the asymmetric risk to create an unacceptable liability
exposure. Rejected on principle.

---

### Option C: DNS-Based Trademark Check (REJECTED)

Use DNS lookups against known trademark holder domains and keyword-matching
instead of querying official trademark registries.

**Examples:**
- Check if `coca-cola.domains` resolves → assume Coca-Cola enforces trademarks
- Keyword-match against a curated list of 500 high-risk brand names.

**Advantages:**
- No API calls: DNS lookups are fast and free.
- No API credentials to manage.

**Disadvantages:**
- Incomplete: only detects trademarks that the operator has pre-curated.
  Misses new registrations and marks from smaller companies.
- No legal defensibility: a "DNS-based check" has no standing in a UDRP
  proceeding. The operator cannot argue they performed due diligence.
- DNS resolution is not a reliable indicator of enforcement intent.
- Hundreds of thousands of active US trademarks exist; a curated list of 500
  covers < 0.1% of them.

**Cost Implications:** Zero monetary cost. Higher liability risk than not
checking at all (false sense of security).

**Risk Assessment:** Very high. Provides no meaningful trademark protection
while creating a false sense of safety. The operator would believe they
checked when they did not.

---

## Decision

**Chosen option: Option A — Mandatory Gate with Caching, Retry, and Unverified Verdict**

The rationale is driven by the decision drivers:

1. **Asymmetric risk**: The cost of checking two trademark databases is ~1-3
   seconds of latency per domain. The cost of not checking is a potential
   UDRP filing (thousands of EUR). The gate is cheap insurance.

2. **Non-bypassability**: The gate is a stage in the orchestrator. There is
   no `--skip-trademark` flag. The architecture enforces the check. The only
   way to bypass the gate is to modify the source code — which the operator
   would have to do deliberately.

3. **Two-jurisdiction coverage**: USPTO covers US trademarks (`.com`, `.us`,
   `.org`, `.net` domains primarily). EUIPO covers EU trademarks (relevant
   for `.eu` and for brands that operate in Europe). The gate checks both
   when both providers are configured.

4. **Graceful degradation**: The `TrademarkGate` returns exactly three
   verdicts. When a provider errors, the verdict is `Unverified` — the
   candidate is not recommended for purchase. A provider outage never
   produces a false "all clear".

5. **Rate-limit awareness**: The gate runs only on candidates that the
   scoring engine has already recommended. For a typical pipeline run, this
   means 1-5% of initial candidates reach the trademark gate. The
   7-day cache (CachedTrademarkProvider) further reduces repeat lookups.

Option B (skippable) was rejected because it creates an unacceptable
liability exposure. A single operator mistake — "I'll skip it just this once"
— could result in a UDRP filing that exceeds the entire project budget by an
order of magnitude. Option C (DNS-based) was rejected because it provides
meaningless coverage while creating a false sense of security.

## Consequences

### Positive
- Every buy recommendation is trademark-cleared by a government registry API.
  The operator has a defensible due-diligence record.
- The caching layer ensures that re-running the pipeline on the same
  candidate set uses zero new API calls (all cached results within 7-day
  TTL).
- The `Unverified` verdict means a temporary EUIPO outage never results in an
  unchecked recommendation.
- Token-aware matching (ADR-0012) reduces false positives (matching "apple"
  against "pineapple") while catching typo-squatting ("appple" → "apple"
  with Levenshtein distance 1).
- The strict-USPTO-TLD rule (ADR-0012) avoids checking `.com` domains against
  EUIPO (which would be noise) while ensuring `.us` domains are checked
  against USPTO (the relevant jurisdiction).

### Negative
- Pipeline latency increases by 1-3 seconds per recommended candidate.
  A run with 100 initial candidates (typically 1-5 recommended) adds 5-15
  seconds. Mitigated by parallel provider calls and caching.
- EUIPO registration is required for EU trademark coverage. Without it, the
  gate degrades to USPTO-only (logged as a warning).
- The token-aware matching algorithm is more complex than a simple substring
  check, adding maintenance surface area.

### Compliance and Security Implications
- The gate queries government trademark databases. No API keys required for
  USPTO; EUIPO requires free OAuth2 credentials stored in `.env`.
- Search terms are domain SLDs, which are public information. No privacy
  concern.
- Cache expiry (7-day TTL) means a newly filed trademark may take up to 7
  days to be detected on re-checks. This is acceptable for a single-operator
  tool (the operator is not buying daily).

### Migration and Monitoring Plan
- **Migration**: None. This ADR documents the existing design.
- **Monitoring**: The `trademark-gate-stage` records `Blocked` and
  `Unverified` counts in the stage summary. The operator can inspect which
  domains were blocked and why.
- **Cache management**: `dominus maintenance prune --cache-only` forces cache
  eviction. `TM_CACHE_TTL_DAYS` in `.env` controls the TTL.

### Validation
- All trademark gate tests (12 tests) and match detector tests (18 tests)
  pass.
- Trademark provider tests (20 tests) cover USPTO and EUIPO response parsing,
  error handling, and credential management.
- Integration tests in `pipeline-run-service` validate that TM-blocked
  candidates appear in the pipeline result with `trademark_blocked` status.
- Production validation: run the pipeline against a domain containing a known
  trademark (e.g., containing "google" as SLD). The gate must return `Blocked`.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the product vision previously documented in
`dominus-product-vision.md` (v0.2), now superseded by this ADR series.
Template: `docs/adr/template.md`.*
