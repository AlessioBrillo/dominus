# ADR-0073: Per-Query DNSSEC Validation with @relaycorp/dnssec

**Status**: Accepted  
**Date**: 2026-09-23  
**Supersedes**: None  
**Related**: ADR-0002, ADR-0061, ADR-0072

## Context

The UnboundResolver (ADR-0072) uses a resolver-level negative-control probe (`sigfail.verteiltesysteme.net`) at boot and every 10 minutes to prove DNSSEC validation is active. However, `node:dns` exposes no per-query AD flag, so the resolver stamps every Available verdict with the same DNSSEC status (`valid` or `unchecked`) based on the last successful probe.

**Critical gap**: Between revalidations (default 10 min), a resolver could be reconfigured via `rndc` to `val-permissive-mode: yes`, causing it to accept bogus signatures. During this window, Available verdicts would be stamped `valid` despite no cryptographic validation occurring.

## Decision

1. **Optional per-query DNSSEC validation**: Add `DNS_PER_QUERY_DNSSEC` flag (default: `false`) that triggers a full cryptographic DNSSEC chain validation (DS → DNSKEY → RRSIG) for each Available verdict using `@relaycorp/dnssec`.

2. **Resolver adapter**: The validation uses the same Unbound host resolver instance, passed to `@relaycorp/dnssec` for the cryptographic verification.

3. **Fail-open on timeout/error**: If per-query validation times out (default 2s) or errors, fall back to the resolver-level stamp instead of downgrading the verdict. This preserves availability while adding defense-in-depth.

4. **Mode-aware mapping**:
   - `strict`: Only `valid` passes; `bogus` → `unchecked`, `insecure` → `unchecked`
   - `permissive`: `valid` or `insecure` → `valid`; `bogus` → `unchecked`
   - `disabled`: Always `unchecked`

5. **Configuration**:
   - `DNS_PER_QUERY_DNSSEC`: Enable feature (default: `false`)
   - `DNS_PER_QUERY_DNSSEC_TIMEOUT_MS`: Per-query timeout (default: 2000ms)

## Consequences

### Positive
- **Cryptographic proof per domain**: Closes the revalidation window where `val-permissive-mode` could bypass validation.
- **Defense in depth**: Resolver-level probe + per-query validation = two independent validation layers.
- **Conservative (ADR-0002)**: Fail-open preserves availability; false positives are impossible, only false negatives (missed Available) which is acceptable.
- **Observability**: Per-query validation duration and outcome can be added to metrics.

### Negative
- **Latency**: Adds ~50-200ms per Available domain (only when enabled and DNSSEC validation is active).
- **CPU cost**: Cryptographic verification per domain.
- **Complexity**: Requires resolver adapter; production use needs proper `@relaycorp/dnssec` Resolver integration.

### Neutral
- Default `false` maintains current behavior for existing deployments.
- Only affects Available verdicts; Registered/Unknown unchanged.

## Implementation Files

- `src/providers/dns/dnssec-validation.ts`: Core validation logic with injectable test fn
- `src/providers/dns/unbound-resolver.ts`: Integration in `#lookup()` for Available verdicts
- `src/app/provider-factory.ts`: Config propagation
- `src/config.ts`: New config options

## Verification

- All existing tests pass (2375)
- New test file: `src/providers/dns/__tests__/dnssec-per-query-validation.test.ts` (6 tests)
- TypeScript strict: clean
- ESLint: clean

## Rollback

Set `DNS_PER_QUERY_DNSSEC=false` to disable entirely. No schema changes.