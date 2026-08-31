# ADR-0068: DNS Tertiary Dual-Redundancy for SPOF Elimination

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-31 |
| **Authors** | Alessio Brillo |
| **Deciders** | Alessio Brillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0002, ADR-0039, ADR-0045, ADR-0059, ADR-0064, ADR-0065 |
| **Project** | DOMINUS |

## Context

The 2-of-3 DNS consensus gate (ADR-0039, ADR-0045) makes every Available verdict rest on up to three resolver opinions: a primary multi-resolver strategy, a consensus secondary, and an optional tertiary. ADR-0064 wired the tertiary into the production override using a new `doh-alternate` strategy (Cisco OpenDNS) so the gate survives a dead recursor. ADR-0065 added Digital Society as a second operator to the `doh-alternate` group so the tertiary survives the loss of either operator.

However, the implementation in ADR-0065 still created a **single NodeDnsProvider** for the tertiary leg using the `doh-tertiary` strategy (which includes both OpenDNS and Digital Society). This means:

1. **Single circuit breaker**: If one operator (e.g., OpenDNS) fails, the shared circuit breaker opens for the entire tertiary leg, disabling both operators simultaneously.
2. **Single rate limiter**: Both operators share the same rate-limit budget.
3. **No true redundancy**: A failure of one endpoint affects the entire tertiary opinion.

The tertiary leg should provide genuine redundancy: if one operator is unreachable, the other should still be able to rescue Available verdicts.

## Decision Drivers

1. **Conservatism (ADR-0002)** — the engine must be more conservative than commercial appraisers; a single-operator tertiary leg is a SPOF that violates this principle under failure.
2. **SLO Observability (ADR-0064)** — per-leg latency histograms exist; we need a dual-redundant tertiary so alerts can distinguish "one operator degraded" from "tertiary leg disabled".
3. **Circuit Breaker Isolation (ADR-0059)** — each resolver endpoint should have its own breaker; a shared breaker for two operators defeats the purpose.
4. **Zero-cost discipline (ADR-0001)** — both OpenDNS and Digital Society are free public resolvers; no new infrastructure cost.

## Considered Options

### Option A: Dual-redundant tertiary with two independent NodeDnsProvider instances (Chosen)

Create two separate `NodeDnsProvider` instances for the tertiary leg:
- Provider 1: `DNS_TERTIARY_STRATEGY_1` (default: `doh-alternate` → OpenDNS over DoH wire format)
- Provider 2: `DNS_TERTIARY_STRATEGY_2` (default: `doh-tertiary` → Digital Society over DoH wire format)

Each has:
- Own rate limiter (split budget: 5 req/sec each, total 10 matching legacy tertiary budget)
- Own circuit breaker (shared registry via `DnsBreakerRegistry`)
- Independent disjointness validation against primary and secondary

Race semantics:
- **Rescue path** (`requiredConfirmations=1`): First Available from ANY tertiary provider rescues the domain.
- **Veto path**: ANY Registered from ANY tertiary provider vetoes the domain.
- **Strict mode** (`requiredConfirmations=2`): Secondary must confirm AND at least one tertiary must confirm.

**Advantages:**
- True redundancy: one operator failure doesn't disable the entire tertiary leg.
- Independent circuit breakers: OpenDNS failure doesn't block Digital Society.
- Independent rate limiting: each operator gets fair share.
- Backward compatible: legacy single-tertiary mode still works (`DNS_TERTIARY_DUAL_REDUNDANT=false`).
- Zero-cost: both endpoints are free public resolvers.

**Disadvantages:**
- Two extra DoH queries per Available domain needing tertiary (bounded by `DNS_TERTIARY_BULK_CONCURRENCY`).
- Slightly more complex configuration (two strategy env vars).

**Cost Implications:** None — both endpoints are free public resolvers. Total rate limit budget unchanged (10 req/sec split 5/5).

**Risk Assessment:** Low. The dual-redundant mode is opt-in via `DNS_TERTIARY_DUAL_REDUNDANT=true` (default true). Legacy mode preserved for backward compatibility. Existing deployments using `doh-tertiary` strategy continue to work.

---

### Option B: Keep single tertiary provider with internal multi-endpoint logic

Modify `NodeDnsProvider` to race multiple DoH endpoints internally and return the first successful result.

**Advantages:**
- Single provider interface, simpler wiring.

**Disadvantages:**
- Shared circuit breaker: can't isolate operator failures.
- Shared rate limiter: can't split budget per operator.
- Telemetry mixing: latency histogram would blend both operators.
- Violates ADR-0059 (per-endpoint circuit isolation).

**Cost Implications:** None.

**Risk Assessment:** Medium — would require significant refactoring of `NodeDnsProvider` internals, breaking the clean abstraction where each provider represents one resolver group.

---

### Option C: Use existing `doh-alternate` group with fallback inside `NodeDnsProvider`

The `doh-alternate` strategy already includes both OpenDNS and Digital Society. Keep single provider but add internal fallback logic.

**Advantages:**
- No config changes.

**Disadvantages:**
- Same as Option B: shared breaker, shared rate limiter, mixed telemetry.
- The existing `NodeDnsProvider` multi-endpoint race is for *primary* speed, not *consensus* redundancy — different failure semantics.

**Risk Assessment:** High — conflates primary optimization with consensus redundancy.

## Decision Outcome

**Chosen: Option A — Dual-redundant tertiary with two independent NodeDnsProvider instances.**

Implementation details:
- New env vars: `DNS_TERTIARY_STRATEGY_1`, `DNS_TERTIARY_STRATEGY_2`, `DNS_TERTIARY_DUAL_REDUNDANT`, `DNS_TERTIARY_RATE_LIMIT_TOKENS_1`, `_2`, `_INTERVAL_MS_1`, `_2`.
- New `TertiaryDnsConfig` type in `ConsensusConfig` with `primary`, `secondary` providers and `strategy: 'dual-redundant' | 'single'`.
- `ConsensusDnsProvider` races both providers; first Available rescues, any Registered vetoes.
- `buildDnsConsensusConfig` creates two providers with split rate budgets and independent disjointness checks.
- `validateRuntimeConsensusDisjointness` updated to accept array of tertiary providers.
- `probeConsensusProvider` probes all tertiary providers at startup.
- Prometheus alert `DnsTertiaryLegDegraded` fires when exactly one of two operators has an open breaker.

## Consequences

### Positive
- The production override's tertiary leg survives the loss of OpenDNS or Digital Society independently.
- Circuit breaker isolation per operator (ADR-0059): OpenDNS failure doesn't block Digital Society queries.
- Rate limiting fairness: each operator gets dedicated 5 req/sec budget.
- Observability: `DnsTertiaryLegDegraded` alert distinguishes partial degradation from total tertiary loss.
- Backward compatible: `DNS_TERTIARY_DUAL_REDUNDANT=false` preserves legacy single-tertiary behavior.
- Zero-cost: both operators are free public resolvers.

### Negative
- Two DoH queries per Available domain needing tertiary (bounded by `DNS_TERTIARY_BULK_CONCURRENCY=10`).
- Slightly more complex configuration surface (two strategy env vars).
- The `tertiaryConfig` object adds a new wiring seam between factory and ConsensusDnsProvider.

### Compliance and Security Implications
- All queries to OpenDNS/Digital Society are DNS lookups of candidate domains — same data class already sent to Cloudflare/Google/Quad9/Unbound.
- DNSSEC validation unaffected: tertiary providers are plain DoH resolver opinions like the primary's legs.
- No secrets, keys, or paid APIs involved.

### Migration and Monitoring Plan
- Rollout: `DNS_TERTIARY_DUAL_REDUNDANT=true` by default in production override; community edition defaults to true but only activates when consensus is enabled.
- Monitoring: `dominus_dns_leg_duration_ms` with `role="tertiary"` shows both endpoints; `dominus_dns_breaker_open` per endpoint tracks health.
- Alert rules: `DnsTertiaryLegDegraded` (one operator down), `DnsTertiaryBreakerOpen` (any endpoint breaker open).
- Success criteria: during a deliberate OpenDNS slow-down, Digital Society rescues Available verdicts; alert fires on partial degradation; no verdict fabricated.
- Rollback: `DNS_TERTIARY_DUAL_REDUNDANT=false` reverts to legacy single-tertiary behavior; code path is env-gated and additive.

### Validation
- Unit tests: dual-redundant race rescue/veto, circuit isolation, disjointness checks, legacy mode.
- Integration test: `consensus-wiring.test.ts` boots gate with dual-redundant tertiary from production override env.
- Bootstrap probe: both tertiary providers probed at startup with `forceRecheck=true`.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`.*