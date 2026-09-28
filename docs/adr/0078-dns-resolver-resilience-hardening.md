# ADR-0078: DNS Resolver Resilience Hardening — Quorum, DNSSEC State Persistence, Cache Purge on Validation Loss

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-09-28 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0072, ADR-0073, ADR-0075, ADR-0002 |
| **Project** | DOMINUS |

## Context

The DOMINUS pipeline relies on a local Unbound recursive resolver as the single source of truth for DNS (ADR-0075). The current architecture has several resilience gaps that become critical in production cloud deployments:

1. **Single Point of Failure**: With `DNS_UNBOUND_STRICT=true` (default), there is no fallback to Node.js native DNS. If all Unbound hosts become unhealthy, the entire DNS pipeline stage fails closed, blocking all candidate processing.

2. **DNSSEC Validation State Drift**: DNSSEC validation is proven at startup via negative-control probe and revalidated periodically (default 10 min). A malicious or accidental reconfiguration of Unbound (`val-permissive-mode: yes` via `rndc`) between revalidations goes undetected. Per-query DNSSEC validation (ADR-0073) mitigates this only for `Available` verdicts.

3. **Quorum Hardcoded to 1**: `DNS_UNBOUND_MIN_HEALTHY_HOSTS` defaults to `1`. In a 3-host deployment, losing 2 hosts still reports "healthy" — but the remaining host may have compromised validation. There is no true quorum enforcement.

4. **Persistent Cache Corruption on Validation Loss**: When DNSSEC validation is lost (detected at revalidation), the in-memory cache is cleared but the persistent DB cache is NOT purged. Verdicts stamped `dnssec: 'valid'` from the compromised period remain in the database and are re-served on subsequent runs/restarts, poisoning the pipeline with false `Available` verdicts.

5. **Cold-Start Validation Window**: On every process restart, the resolver must re-prove DNSSEC validation via health check before accepting traffic. This adds 2-5s latency at startup and creates a window where no DNS resolution is possible.

These issues are acceptable for single-user community edition but are blockers for multi-tenant cloud SLA requirements.

## Decision Drivers

1. **Production Resilience** — Multi-tenant cloud deployments require true quorum (majority) and automatic failover without manual intervention. A single host failure must not degrade the resolver; a majority failure must fail fast.

2. **DNSSEC Validation Integrity (ADR-0002 Conservatism)** — The "valid" DNSSEC stamp on `Available` verdicts must be cryptographically trustworthy. Any window where a compromised validation state can serve false positives is unacceptable.

3. **Operational Simplicity** — Configuration should be declarative via env vars. No code changes should be needed to adjust quorum mode or enable/disable persistence.

4. **Zero-Downtime Deployments** — Restarting the API/worker/scheduler pods must not require re-proving DNSSEC from scratch. Persisted validation state eliminates the cold-start window.

5. **Observability & Auditability** — Every DNSSEC validation state change must be measurable (Prometheus metrics) and auditable (structured logs with host, timestamp, previous/new state).

## Considered Options

### Option A: Quorum-Based Health + DNSSEC State Persistence + Cache Purge (Chosen)

**Description**: Implement three orthogonal hardening mechanisms:
1. **Configurable Quorum**: New `DNS_UNBOUND_QUORUM_MODE` env var (`simple` | `majority` | `all`, default `majority`). `isHealthy()` evaluates against dynamic quorum.
2. **DNSSEC State Persistence**: On each periodic revalidation, persist per-host validation state (`dnssecValid`, `healthy`, `lastCheckAt`, `consecutiveFailures`) to `provider_cache` with TTL. On startup, load persisted state via `loadDnssecState()` before health check — if state is fresh (< 1h) and `dnssecValid=true`, skip the negative-control probe for that host.
3. **Cache Purge on Validation Loss**: When revalidation detects `dnssecValid` transitioning `true → false` globally, purge ALL persistent cache entries for the Unbound provider. Conservative: better to re-resolve than serve potentially corrupted `Available` verdicts.

**Advantages:**
- True majority quorum prevents split-brain in multi-host deployments
- Cold-start eliminated: persisted state restores validation proof in < 50ms vs 2-5s health check
- Cache corruption impossible: validation loss triggers full persistent cache purge
- Declarative config: all behavior controlled via env vars, no code changes
- Backward compatible: defaults preserve current behavior for community edition

**Disadvantages:**
- Additional DB writes on every revalidation (10 min interval, ~N hosts × 1 row) — negligible overhead
- Persistent cache purge is blunt instrument (purges Registered + Available) — could be refined with indexed purge later
- Requires `provider_cache.clearProvider()` method (new repository method)

**Cost Implications:**
- Dev effort: ~2 days (core logic + tests + config wiring)
- Operational: +1 DB write per host per 10 min (negligible)
- No licensing/API cost impact

**Risk Assessment:**
- Technical: Low — additive changes, existing health check remains as fallback
- Migration: Zero — feature-flagged via env vars, safe defaults
- Vendor: None — pure application-level logic

---

### Option B: External Consensus Service (etcd/Consul) for DNSSEC State

**Description**: Deploy a lightweight consensus store (etcd) alongside Unbound. Unbound sidecars write validation state to etcd; application reads from etcd. Quorum enforced by etcd cluster.

**Advantages:**
- Industry-standard consensus, battle-tested
- Survives application process restarts inherently
- Can coordinate across multiple application instances

**Disadvantages:**
- Major operational complexity: new infrastructure component (etcd cluster, TLS, backups)
- Additional failure domain: etcd outage = DNS resolver outage
- Overkill for single-application DNSSEC state (not multi-cluster)
- Violates DOMINUS principle of minimal infrastructure (ADR-0018)

**Cost Implications:**
- Dev effort: ~2 weeks (infra, integration, testing)
- Operational: etcd cluster (3 nodes minimum), monitoring, backup strategy
- Significant complexity budget

**Risk Assessment:**
- Technical: High — new distributed system failure modes
- Migration: High — requires infra changes before app changes
- Vendor: None but operational burden significant

---

### Option C: Per-Query DNSSEC Validation for ALL Verdicts (No Persistence)

**Description**: Extend ADR-0073 per-query validation to `Registered` and `Unknown` verdicts, not just `Available`. Remove persistent cache entirely for DNS. Rely solely on cryptographic proof per query.

**Advantages:**
- Eliminates validation state drift entirely — every verdict cryptographically proven
- No persistent cache to corrupt
- Simpler mental model: no state to persist/purge

**Disadvantages:**
- Performance: @relaycorp/dnssec validation adds 50-200ms per query. At 200 bulk concurrency × 50k candidates = 10M+ validations/run → hours of added latency
- Cost: Upstream resolver load increases 10-100x (full DNSSEC chain walk per query)
- Availability: If validation times out, verdict becomes `Unknown` — pipeline throughput drops
- Does not solve quorum/SPOF problem

**Cost Implications:**
- Dev effort: ~1 week (extend per-query to all verdicts, tune timeouts)
- Operational: Significantly higher resolver CPU, upstream query volume
- Potential need for dedicated validation resolvers

**Risk Assessment:**
- Technical: High — performance regression likely unacceptable for pipeline SLAs
- Migration: Medium — can be feature-flagged but changes semantics
- Vendor: Upstream resolver operators may rate-limit/block aggressive validation

---

### Option D: Status Quo + Documentation/Runbooks

**Description**: Document the known gaps in runbooks. Operators manually monitor Unbound health, manually purge cache on suspected validation loss, accept cold-start latency.

**Advantages:**
- Zero dev effort
- Zero code risk

**Disadvantages:**
- Human-dependent: relies on operator vigilance, 24/7 on-call
- Not auditable: no metrics on validation state drift
- Does not meet cloud SLA requirements
- Incident response time: minutes to hours vs milliseconds automatic

**Cost Implications:**
- Dev effort: 0
- Operational: High ongoing (on-call burden, manual interventions)

**Risk Assessment:**
- Technical: None (no code change)
- Operational: High — human error inevitable under pressure
- Compliance: Fails SOC2-type availability/integrity requirements

## Decision

**Chosen option: Option A (Quorum-Based Health + DNSSEC State Persistence + Cache Purge)**

Rationale:
- **Driver 1 (Production Resilience)**: Majority quorum is the standard for 3+ node clusters. `simple` mode (current) is explicitly deprecated for production via default `majority`. `all` mode available for ultra-conservative deployments.
- **Driver 2 (DNSSEC Integrity)**: Cache purge on validation loss is the only mechanism that guarantees no corrupted `Available` verdicts survive a validation compromise. The blunt purge is acceptable because DNS cache TTL is short (7 days) and re-resolution is fast (< 100ms cached, ~500ms live).
- **Driver 3 (Operational Simplicity)**: All three mechanisms controlled by 4 new env vars with safe defaults. Community edition unchanged (`DNS_UNBOUND_QUORUM_MODE=simple` can be set explicitly).
- **Driver 4 (Zero-Downtime)**: `loadDnssecState()` restores validation proof from DB in < 50ms. Eliminates the 2-5s health check blocking at startup. Critical for rolling deploys where pods restart frequently.
- **Driver 5 (Observability)**: New metrics `dominus_unbound_dnssec_state_restored`, `dominus_unbound_cache_purged`, `dominus_unbound_quorum_evaluated` provide full audit trail.

Alternatives rejected:
- **B**: Infrastructure complexity disproportionate to problem scope. DOMINUS avoids external consensus stores (ADR-0018).
- **C**: Performance regression violates pipeline SLA (< 30 min for 50k candidates). Per-query validation remains for `Available` only (ADR-0073).
- **D**: Unacceptable for cloud product. Manual runbooks don't scale.

## Consequences

### Positive
- **True quorum**: 3-host deployment tolerates 1 host failure without degradation; 2 failures = fail-fast (no split-brain)
- **Sub-50ms cold start**: Persisted DNSSEC state eliminates startup health check blocking
- **Zero cache corruption**: Validation loss → immediate full cache purge guarantees no stale `dnssec: 'valid'` entries
- **Full observability**: Every state transition (validation gained/lost, quorum met/failed, cache purged) emits structured metrics
- **Backward compatible**: Defaults preserve current behavior; community edition unaffected

### Negative
- **Blunt cache purge**: Purges ALL entries (Registered + Available) on validation loss. Could cause temporary resolution spike. Mitigated by: short TTL (7 days), fast re-resolution, rare event (validation loss should be extremely rare in properly configured Unbound).
- **New DB dependency**: `provider_cache` table now stores DNSSEC state. Schema migration not required (uses existing key-value), but adds write load (~N hosts / 10 min).
- **Config surface area**: 4 new env vars. Documented in config.ts with clear defaults.

### Compliance and Security Implications
- **Integrity**: Strengthens ADR-0002 conservatism — `Available` verdicts with `dnssec: 'valid'` are now guaranteed to come from a currently-validating resolver, or be re-validated per-query (ADR-0073).
- **Availability**: Quorum mode `majority` improves availability over `simple` (1 of 3) by preventing single-host-failure degradation, while `all` mode provides maximum integrity at cost of availability.
- **Auditability**: Metrics provide tamper-evident log of validation state changes for compliance reviews.

### Migration and Monitoring Plan
1. **Phase 1 (This PR)**: Implement core logic behind feature flags. Default `DNS_UNBOUND_QUORUM_MODE=majority` for new deployments; existing deployments can set `=simple` to preserve behavior.
2. **Phase 2 (Canary)**: Deploy to staging with 3-host Unbound. Verify metrics: `dominus_unbound_quorum_evaluated{mode="majority"}`, `dominus_unbound_dnssec_state_restored_total`.
3. **Phase 3 (Production)**: Enable `DNS_UNBOUND_PURGE_CACHE_ON_DNSSEC_LOSS=true` (default). Monitor `dominus_unbound_cache_purged_total` — should remain 0 in steady state.
4. **Rollback**: Set `DNS_UNBOUND_QUORUM_MODE=simple`, `DNS_UNBOUND_PERSIST_DNSSEC_STATE=false`, `DNS_UNBOUND_PURGE_CACHE_ON_DNSSEC_LOSS=false`. No schema changes to revert.

### Validation
- **Unit Tests**: `unbound-resolver-quorum.test.ts` (quorum modes), `unbound-resolver-dnssec-persistence.test.ts` (persist/load/purge)
- **Integration Test**: `dns-prefilter-stage.test.ts` with mocked Unbound returning validation loss → verify cache purge
- **Chaos Test**: Kill 2/3 Unbound hosts → verify resolver reports unhealthy, pipeline degrades gracefully
- **Performance**: Benchmark cold-start with/without persisted state (target: < 50ms vs 2-5s)
- **Success Criteria**: Zero `dominus_unbound_cache_purged_total` in 30 days production; cold-start p99 < 100ms; quorum evaluation p99 < 1ms

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`.*