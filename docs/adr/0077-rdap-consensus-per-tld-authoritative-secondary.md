# ADR-0077: RDAP Consensus Per-TLD Authoritative Secondary Leg with Cloud-Mode Fail-Open Default

**Status**: Accepted  
**Date**: 2026-09-26  
**Supersedes**: ADR-0074 (RDAP Consensus Probe Resilience with Retry and Fail-Open)  
**Related**: ADR-0050, ADR-0051, ADR-0058, ADR-0035

## Context

ADR-0074 introduced retry/backoff/fail-open for the RDAP consensus second-leg startup probe, but kept `RDAP_CONSENSUS_PROBE_FAIL_OPEN=false` as default (fail-fast). This creates an operational risk: `rdap.org` (the default consensus endpoint) is a public service without SLA. Transient outages cause complete service downtime until recovery + restart.

**Additional architectural problem**: The current consensus architecture uses a single universal secondary endpoint (`rdap.org`) for all TLDs. This creates two issues:
1. **Origin overlap risk**: The secondary may resolve to the same authoritative server as the primary for certain TLDs (e.g., Verisign for .com/.net), making the 2-of-2 gate a rubber stamp.
2. **Suboptimal latency/reliability**: A universal router adds an extra hop vs. querying the authoritative RDAP server directly for each TLD.

## Decision

### 1. Cloud-Mode-Aware Fail-Open Default
Change `RDAP_CONSENSUS_PROBE_FAIL_OPEN` default to **`true` in cloud mode** (DATABASE_URL set or AUTH_PROVIDER ≠ 'env'), **`false` in community edition**.

Rationale: Cloud deployments run in managed environments with expected high availability. Community edition users self-host and can opt-in to fail-open if they accept reduced verification guarantees.

### 2. Per-TLD Authoritative Secondary Providers
Replace the single `RDAP_CONSENSUS_ENDPOINT` with **per-TLD authoritative RDAP servers** resolved from the IANA bootstrap (same source as the primary).

- The primary `FailoverRdapProvider` already uses `IanaRdapBootstrap` to get authoritative servers per TLD.
- The secondary consensus leg will now **also** use the IANA bootstrap to get authoritative servers for each TLD, but from a **different network path** (e.g., different resolver, different geographic egress).
- `RDAP_CONSENSUS_ENDPOINT` becomes an **optional override** for specific TLDs where the operator wants a specific secondary (e.g., `rdap.verisign.com` for .com/.net).

### 3. Origin Disjointness Enforcement Per-TLD
The existing `hasAuthoritativeOriginOverlap` check in `RdapConfirmationStage` already validates per-TLD. With per-TLD secondary providers, this check becomes more precise: it compares the secondary's authoritative origins for that specific TLD against the primary's.

### 4. Graceful Degradation on Probe Failure
When the consensus probe fails and fail-open activates:
- Log a structured warning with `tenant_id` context (if available)
- Emit Prometheus metric `dominus_rdap_consensus_probe_failed_total{mode="fail-open"}`
- Disable consensus gate for this run (set `rdapConsensusConfig = undefined`)
- Primary RDAP continues to operate normally

## Configuration

| Variable | Default (Cloud) | Default (Community) | Description |
|----------|-----------------|---------------------|-------------|
| `RDAP_CONSENSUS_PROBE_FAIL_OPEN` | `true` | `false` | Allow startup to continue if consensus probe fails |
| `RDAP_CONSENSUS_ENDPOINT` | *optional override* | *optional override* | Per-TLD secondary endpoint override (JSON map) |
| `RDAP_CONSENSUS_PROBE_RETRY` | `3` | `3` | Retry attempts before fail-open |
| `RDAP_CONSENSUS_PROBE_BACKOFF_MS` | `5000` | `5000` | Base backoff for exponential retry |

New config for per-TLD override:
```
RDAP_CONSENSUS_ENDPOINT_OVERRIDES='{"com":"https://rdap.verisign.com/com/domain/","net":"https://rdap.verisign.com/net/domain/"}'
```

## Implementation Changes

### 1. `src/config.ts`
- `RDAP_CONSENSUS_PROBE_FAIL_OPEN.default()` → `detectCloudMode(process.env)`
- Add `RDAP_CONSENSUS_ENDPOINT_OVERRIDES` (JSON string mapping TLD → URL)

### 2. `src/app/provider-factory.ts`
- `createRdapConsensusConfig()` → builds `Map<TLD, RdapProvider>` for secondary leg using IANA bootstrap
- `RDAP_CONSENSUS_ENDPOINT_OVERRIDES` merges as overrides on top of IANA-resolved servers
- `probeRdapConsensusEndpoint()` → probes a sample of TLDs (com, net, org, io) instead of single endpoint

### 3. `src/pipeline/stages/rdap-confirmation-stage.ts`
- `RdapConsensusConfig.secondaryProvider` → `secondaryProviders: Map<string, RdapProvider>`
- `#verifyConsensus()` selects provider by `candidate.tld`
- `secondaryOrigin` computed per-TLD for provenance

### 4. `src/app/composition-root.ts`
- Handle `probeResult.wasFailOpen` with structured logging + metrics
- No `process.exit(1)` on probe failure in cloud mode (fail-open default)

## Consequences

### Positive
- **Production resilience**: Cloud deployments survive rdap.org outages without manual intervention
- **Stronger verification**: Per-TLD authoritative secondary eliminates origin overlap for most TLDs
- **Lower latency**: Direct authoritative queries vs. universal router hop
- **Operational clarity**: Fail-open is explicit default in cloud, opt-in in community

### Negative
- **Increased complexity**: Multiple secondary providers instead of one
- **Resource usage**: More connections/circuit breakers per TLD (mitigated: only created for TLDs actually queried)
- **Configuration surface**: New `RDAP_CONSENSUS_ENDPOINT_OVERRIDES` option

### Neutral
- Backward compatible: `RDAP_CONSENSUS_ENDPOINT` still works as global fallback
- Community edition unchanged by default (conservative)
- Tertiary leg (ADR-0050 extension) still supported on top of per-TLD secondary

## Verification

- All existing tests pass
- New integration test: consensus probe fail-open behavior in cloud mode
- New integration test: per-TLD secondary provider selection
- TypeScript strict: clean
- ESLint: clean

## Rollback

Set `RDAP_CONSENSUS_PROBE_FAIL_OPEN=false` to restore fail-fast behavior.
Set `RDAP_CONSENSUS_ENDPOINT` (single URL) to use legacy single-endpoint mode (code handles both).
No schema changes required.

## Implementation Files

- `src/config.ts`: Cloud-mode-aware default + new override config
- `src/app/provider-factory.ts`: Per-TLD secondary provider construction + multi-TLD probe
- `src/pipeline/stages/rdap-confirmation-stage.ts`: Per-TLD secondary selection
- `src/app/composition-root.ts`: Fail-open handling with metrics
- `src/providers/rdap/rdap-consensus-validator.ts`: Per-TLD overlap check (already supports)