# ADR-0069: DNS Secondary Dual-Redundancy for Consensus Gate Resilience

## Metadata

| Field          | Value                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| **Status**     | Accepted                                                                                 |
| **Date**       | 2026-09-06                                                                               |
| **Authors**    | Alessio Brillo                                                                           |
| **Deciders**   | Alessio Brillo                                                                           |
| **Supersedes** | ADR-00XX (placeholder in config/provider-factory)                                        |
| **Relates to** | ADR-0002, ADR-0039, ADR-0044, ADR-0045, ADR-0059, ADR-0063, ADR-0064, ADR-0065, ADR-0068 |
| **Project**    | DOMINUS                                                                                  |

## Context

The 2-of-3 DNS consensus gate (ADR-0039, ADR-0045) cross-validates every `Available` verdict from the primary resolver against a secondary independent resolver. Since ADR-0068, the tertiary leg uses dual-redundant topology (two independent operators with separate circuit breakers and rate limiters).

However, the secondary leg remained single-provider: a single `NodeDnsProvider` instance built from `DNS_CONSENSUS_STRATEGY` (default `dot-alternate` = AdGuard/Mullvad/NextDNS over DoT). This created an asymmetry:

- Tertiary leg: dual-redundant, survives loss of either operator
- Secondary leg: single point of failure, loss degrades gate to 1-of-1

The dual-redundant secondary was prototyped in `buildSecondaryConsensusProviders()` (ADR-00XX placeholder) but never fully wired through `ConsensusDnsProvider` and `ConsensusEngine`. The wiring split:

1. `provider-factory.ts` creates two secondary providers but returns bare `DnsProvider[]` without groups/endpoints
2. `composition-root.ts` reconstructs array from `secondaryConfig` but drops `tertiaryConfig`
3. `consensus-engine.ts` has dual code paths (`secondaryProviders[]` vs `secondaryConfig`) with divergent semantics
4. `ConsensusDnsProvider` constructor accepts `secondaryProviders[]` but ignores `secondaryConfig`

Result: depending on code path, the gate runs single, dual, or degraded without telemetry distinction.

## Decision Drivers

1. **Conservatism (ADR-0002)** — an `Available` verdict is the risky verdict; the gate must eliminate single-resolver opinions. A single secondary leg is a SPOF that violates this principle under failure.
2. **Symmetry with tertiary (ADR-0068)** — if dual-redundant is correct for tertiary, it is correct for secondary. Asymmetry creates a weaker link.
3. **Operational honesty** — `provider-status` and metrics must reflect the gate that actually runs (cardinality: single/dual-s/dual-t), not the intended one.
4. **Zero-cost discipline (ADR-0001)** — `dot-alternate` (AdGuard) and `dot-consensus` (Mullvad/NextDNS) are free public DoT resolvers; no new infrastructure.
5. **Fail-closed quorum** — `requiredConfirmations=1` (default): ANY Available from s1 OR s2 confirms (1-of-2 rescue). `requiredConfirmations=2`: BOTH secondary AND tertiary must confirm. The secondary dual is **not** a 2-of-2 quorum — that would invert conservatism by requiring two independent confirmations instead of one rescue.

## Considered Options

### Option A: Dual-redundant secondary with 1-of-2 rescue + ANY veto (Chosen)

Create two independent `NodeDnsProvider` instances for the secondary leg:

- Provider s1: `DNS_CONSENSUS_STRATEGY_1` (default: `dot-alternate` → AdGuard over DoT)
- Provider s2: `DNS_CONSENSUS_STRATEGY_2` (default: `dot-consensus` → Mullvad/NextDNS over DoT)

Each has:

- Own rate limiter (split budget: 10 req/sec each, total 20 matching legacy secondary budget)
- Own circuit breaker (shared registry via `DnsBreakerRegistry`)
- Independent disjointness validation against primary

Race semantics (`requiredConfirmations` counts LEGS, not providers):

- **Rescue path** (`requiredConfirmations=1`): First `Available` from s1 OR s2 confirms the secondary leg.
- **Veto path**: ANY `Registered` from s1 OR s2 vetoes the domain (fail-closed).
- **Strict mode** (`requiredConfirmations=2`): Secondary leg (ANY of s1/s2) AND tertiary leg (ANY of t1/t2) must both confirm. Requiring ALL providers within a leg would make a single timeout veto every `Available` and push the `Unknown`-rate to commercially unusable levels.

**Advantages:**

- True redundancy: one operator failure doesn't disable the secondary leg.
- Independent circuit breakers: AdGuard failure doesn't block Mullvad/NextDNS.
- Independent rate limiting: each operator gets dedicated 10 req/sec budget.
- Symmetric with tertiary dual-redundant topology.
- Backward compatible: `DNS_CONSENSUS_DUAL_REDUNDANT=false` preserves legacy single-secondary behavior.
- Zero-cost: both endpoints are free public resolvers.

**Disadvantages:**

- Two extra DoT queries per `Available` domain needing secondary (bounded by `DNS_CONSENSUS_BULK_CONCURRENCY=20`).
- Slightly more complex configuration surface (two strategy env vars).
- Higher `Unknown`-rate when one secondary fails and the other is slow/timeout (mitigated by `DNS_LOOKUP_TIMEOUT_MS`).

**Cost Implications:** None — both endpoints are free public resolvers. Total rate limit budget unchanged (20 req/sec split 10/10).

**Risk Assessment:** Low. Dual-redundant mode is opt-in via `DNS_CONSENSUS_DUAL_REDUNDANT=true` (default true). Legacy mode preserved. Existing deployments using single `DNS_CONSENSUS_STRATEGY` continue to work.

---

### Option B: Keep single secondary, invest in tertiary reliability

Rely on tertiary dual-redundancy as the sole redundancy layer; accept secondary SPOF.

**Disadvantages:**

- Tertiary is only consulted when secondary fails/unknown (`consensus-engine.ts:403-420`). If secondary returns `Unknown` (timeout/error), tertiary rescues. But if secondary returns `Registered` (false positive from single operator), tertiary is never consulted — veto is immediate and irreversible.
- Asymmetric resilience contradicts ADR-0002 conservatism principle.

---

### Option C: Single secondary with internal multi-endpoint race

Modify `NodeDnsProvider` to race multiple DoT endpoints internally.

**Disadvantages:**

- Shared circuit breaker, shared rate limiter, mixed telemetry — same problems ADR-0059 and ADR-0068 solved for tertiary.
- Violates provider abstraction (one provider = one resolver group).

---

## Decision Outcome

**Chosen: Option A — Dual-redundant secondary with two independent NodeDnsProvider instances, 1-of-2 rescue + ANY veto semantics.**

Implementation details:

- New env vars already exist: `DNS_CONSENSUS_STRATEGY_1`, `DNS_CONSENSUS_STRATEGY_2`, `DNS_CONSENSUS_DUAL_REDUNDANT`, `DNS_CONSENSUS_RATE_LIMIT_TOKENS_1/2`, `_INTERVAL_MS_1/2`.
- `ConsensusConfig` unified in `consensus-engine.ts` as single source of truth; `secondaryConfig: SecondaryDnsConfig` with `primary`, `secondary`, `strategy: 'dual-redundant' | 'single'`.
- `ConsensusEngineOptions` carries `secondaryProviders: DnsProvider[]` (length 1|2) and `tertiaryProviders: DnsProvider[]` (length 0|1|2).
- `ConsensusDnsProvider` propagates `secondaryConfig`, `tertiaryConfig`, and all resolver groups/endpoints for runtime re-validation (explicit arrays win, else derived from configs).
- `buildConsensusDnsProvider()` accepts `tertiaryProviders: DnsProvider[]` plus `secondaryConfig`/`tertiaryConfig` and s2/t2 groups for re-validation.
- Quorum: `requiredConfirmations=1` → secondary leg confirms if ANY s1/s2 returns Available, else tertiary leg (ANY t1/t2) rescues; `requiredConfirmations=2` → secondary leg (ANY) AND tertiary leg (ANY) must both confirm.
- Metrics label `leg="s1|s2|t1|t2"`; alerts `DnsSecondaryLegDegraded` (1 of 2 breakers open), `DnsTertiaryLegDegraded`.

## Consequences

### Positive

- The secondary consensus leg survives loss of AdGuard or Mullvad/NextDNS independently.
- Circuit breaker isolation per operator (ADR-0059): AdGuard failure doesn't block Mullvad/NextDNS.
- Rate limiting fairness: each operator gets dedicated 10 req/sec budget.
- Symmetric dual-redundant topology for secondary and tertiary.
- Observability: `DnsSecondaryLegDegraded` alert distinguishes partial degradation from total secondary loss.
- Backward compatible: `DNS_CONSENSUS_DUAL_REDUNDANT=false` reverts to legacy single-secondary.
- Zero-cost: both operators are free public resolvers.

### Negative

- Two DoT queries per `Available` domain needing secondary (bounded by `DNS_CONSENSUS_BULK_CONCURRENCY=20`).
- Slightly more complex configuration surface (two strategy env vars).
- `secondaryConfig`/`tertiaryConfig` objects add wiring seams between factory, consensus-engine, and ConsensusDnsProvider.
- Higher `Unknown`-rate on partial secondary degradation (one timeout + one slow) — monitored via `dominus_dns_consensus_unverifiable_total` and `dominus_dns_leg_duration_ms` with `role="consensus"`.

### Compliance and Security Implications

- All queries to AdGuard/Mullvad/NextDNS are DNS lookups of candidate domains — same data class already sent to Cloudflare/Google/Quad9.
- DNSSEC validation unaffected: secondary providers are plain DoT resolver opinions like the primary's legs.
- No secrets, keys, or paid APIs involved.

### Migration and Monitoring Plan

- Rollout: `DNS_CONSENSUS_DUAL_REDUNDANT=true` by default in production override; community edition defaults to true but only activates when consensus is enabled.
- Monitoring: `dominus_dns_leg_duration_ms` with `role="consensus"` shows both endpoints; `dominus_dns_breaker_open` per endpoint tracks health.
- Alert rules: `DnsSecondaryLegDegraded` (one operator down), `DnsSecondaryBreakerOpen` (any endpoint breaker open).
- Success criteria: during a deliberate AdGuard slow-down, Mullvad/NextDNS rescues `Available` verdicts; alert fires on partial degradation; no verdict fabricated.
- Rollback: `DNS_CONSENSUS_DUAL_REDUNDANT=false` reverts to legacy single-secondary behavior; code path is env-gated and additive.

### Validation

- Unit tests: dual-redundant race rescue/veto, circuit isolation, disjointness checks, legacy mode.
- Integration test: `consensus-wiring.test.ts` boots gate with dual-redundant secondary + dual-redundant tertiary from production override env.
- Bootstrap probe: both secondary providers probed at startup with `forceRecheck=true`.
- Benchmark: `DNS_LIVE=1 npm run bench` measures p95 and query amplification before/after.

---

_This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`._
