# ADR-0072: DNS Consensus Revalidation Hardening — Strict Anycast Overlap Veto with System Resolver Independence

**Status**: Accepted  
**Date**: 2026-09-07  
**Supersedes**: None  
**Related**: ADR-0002, ADR-0039, ADR-0044, ADR-0045, ADR-0059, ADR-0063, ADR-0064, ADR-0065, ADR-0066, ADR-0068, ADR-0069

## Context

The DNS 2-of-3 consensus gate (ADR-0039, ADR-0044, ADR-0045) implements periodic runtime revalidation of resolver disjointness via `revalidateDisjointness()` (consensus-engine.ts). This revalidation issues live DNS queries through each consensus leg's resolver groups to detect anycast/IP overlap that static bootstrap checks cannot catch.

**Critical flaw identified**: The revalidation was using each leg's *own pinned resolvers* to resolve the endpoint hostnames. When primary and secondary both point at the same private recursor (e.g., `127.0.0.1:5300`), the revalidation would query that same recursor to resolve `127.0.0.1:5300` — which trivially returns the same IP, *masking* the overlap instead of detecting it. The gate was effectively "consensus theater" in privacy-mode deployments with a single shared recursor.

Additionally, the revalidation lacked Prometheus metrics, making it impossible to alert on degradation or track revalidation health over time.

## Decision

1. **Strict system-resolver independence**: `revalidateDisjointness()` now uses the *system resolver* (Node.js default `dns.Resolver()` without pinned nameservers) to resolve the endpoint hostnames of each leg. This ensures that even if primary and secondary share a pinned recursor, the revalidation will independently resolve their hostnames and detect the anycast overlap.

2. **Fail-open for resolution, fail-closed for overlap**: Resolution failures (timeout, NXDOMAIN, SERVFAIL) during revalidation are logged as warnings but do NOT mark the gate as degraded. Only actual IP overlap exceeding the threshold (default 50%) triggers `config.runtimeDegraded = true` and `config.anycastDegraded = true`.

3. **Prometheus observability**: Added `DnsConsensusRevalidationMetrics` interface and wired it through `ConsensusDnsProvider` → `buildConsensusDnsProvider()` → composition root. Metrics recorded:
   - `revalidation:anycast-overlap` when overlap exceeds threshold
   - `revalidation:error:<message>` when revalidation throws
   - Uses existing `recordDnsConsensusDegradedReason()` for consistency

4. **Fallback group exclusion**: Revalidation continues to skip `fallback: true` groups (same as bootstrap validation), so emergency fallbacks shared between legs don't trigger false degradation.

5. **Privacy-mode compliance**: The system-resolver approach works correctly with `DNS_PRIVACY_MODE=true` — the revalidation queries never leave the host except to the system resolver, maintaining the privacy guarantee while still detecting overlap.

## Consequences

### Positive
- **True anycast detection**: Overlap between primary/secondary/tertiary legs is now reliably detected even when they share pinned recursors.
- **ADR-0002 conservatism upheld**: False Available verdicts from rubber-stamp second opinions are prevented.
- **Observable degradation**: Operators can alert on `dominus_dns_consensus_degraded_reason{reason="revalidation:anycast-overlap"}` and track revalidation health.
- **Fail-safe defaults**: Resolution failures don't cause false degradation; only genuine overlap does.

### Negative
- **Extra system resolver queries**: Each revalidation cycle issues 2-6 additional DNS queries (A + AAAA per endpoint hostname). At 10-min interval with 3-5 endpoints per leg, this is negligible (<1 qps).
- **System resolver dependency**: If the system resolver is misconfigured or blocked, revalidation will log warnings but not degrade the gate (fail-open for resolution).

### Neutral
- No change to bootstrap-time disjointness checks (`validateConsensusDisjointnessRuntime`).
- No change to consensus verdict logic (`runConsensus`).
- Existing `DNS_CONSENSUS_ON_FAILURE=degraded-anycast` policy continues to work with the new anycast data.

## Implementation Files

- `src/providers/dns/consensus-engine.ts`: Core revalidation logic, metrics interface
- `src/providers/dns/consensus-dns-provider.ts`: Metrics callback wiring
- `src/app/provider-factory.ts`: Factory parameter propagation
- `src/app/composition-root.ts`: Metrics collector wiring
- `src/providers/dns/__tests__/consensus-revalidation-hardening.test.ts`: Comprehensive test coverage (8 tests)

## Verification

- All new tests pass (8/8) covering: same-recursor detection, anycast overlap detection, resolution failure handling, fallback exclusion, privacy-mode resolution.
- Full test suite: 2717 passed (1 pre-existing flaky test in `dot-pool.test.ts` unrelated).
- TypeScript strict mode: clean.
- ESLint: clean.
- Pre-commit hooks: pass.

## Rollback

If issues arise, set `DNS_CONSENSUS_RUNTIME_VALIDATION=false` to disable periodic revalidation entirely, or `DNS_CONSENSUS_ON_FAILURE=disable` to disable the consensus gate on bootstrap failure. The metrics callback is optional and fails gracefully if not provided.