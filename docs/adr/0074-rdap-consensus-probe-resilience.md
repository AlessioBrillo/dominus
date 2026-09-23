# ADR-0074: RDAP Consensus Probe Resilience with Retry and Fail-Open

**Status**: Accepted  
**Date**: 2026-09-23  
**Supersedes**: None  
**Related**: ADR-0050, ADR-0051, ADR-0058

## Context

The RDAP 2-of-2 consensus gate (ADR-0050) requires a startup probe of the second RDAP provider (`RDAP_CONSENSUS_ENDPOINT`, default `rdap.org`). If this probe fails, the process exits with `process.exit(1)` (fail-fast).

**Problem**: `rdap.org` is a public service with occasional transient outages (DNS, network, 5xx). A brief blip causes complete service downtime until the endpoint recovers and the service restarts. This is unacceptable for production deployments.

## Decision

1. **Configurable retry with exponential backoff**: Add `RDAP_CONSENSUS_PROBE_RETRY` (default: 3) and `RDAP_CONSENSUS_PROBE_BACKOFF_MS` (default: 5000ms). Retries use exponential backoff with ±20% jitter.

2. **Fail-open mode**: Add `RDAP_CONSENSUS_PROBE_FAIL_OPEN` (default: `false`). When `true`, a failed probe after all retries logs a warning but allows startup to continue. The 2-of-2 consensus gate is disabled for this run (Available verdicts not independently verified).

3. **Detailed probe result**: Probe returns `{ success, wasFailOpen, attempts }` so callers can distinguish genuine success from fail-open.

4. **Graceful degradation**: When fail-open activates, `rdapConsensusConfig` is set to `undefined`, causing `RdapConfirmationStage` to skip consensus verification entirely (falls back to primary RDAP only).

## Configuration

- `RDAP_CONSENSUS_PROBE_RETRY`: Number of retries (default: 3, max: 10)
- `RDAP_CONSENSUS_PROBE_BACKOFF_MS`: Base backoff for exponential retry (default: 5000ms)
- `RDAP_CONSENSUS_PROBE_FAIL_OPEN`: Enable fail-open (default: `false`)

## Consequences

### Positive
- **Availability**: Transient rdap.org outages no longer cause service downtime.
- **Operational flexibility**: Operators can choose fail-open for high-availability deployments.
- **Observability**: Clear logging of retry attempts, backoff, and fail-open activation.
- **Backward compatible**: Default behavior unchanged (fail-fast after 3 retries).

### Negative
- **Reduced guarantee**: In fail-open mode, Available verdicts lack independent 2-of-2 verification.
- **Complexity**: Additional config options and code paths.

### Neutral
- Fail-open is opt-in; conservative default preserves current behavior.
- Consensus gate can still be disabled entirely via `RDAP_CONSENSUS_ENABLED=false`.

## Implementation Files

- `src/app/provider-factory.ts`: `probeRdapConsensusEndpoint()` with retry/backoff/fail-open
- `src/app/composition-root.ts`: Handle fail-open by disabling `rdapConsensusConfig`
- `src/config.ts`: New config options

## Verification

- All existing tests pass (2375)
- TypeScript strict: clean
- ESLint: clean

## Rollback

Set `RDAP_CONSENSUS_PROBE_FAIL_OPEN=false` (default) to restore fail-fast behavior. No schema changes.