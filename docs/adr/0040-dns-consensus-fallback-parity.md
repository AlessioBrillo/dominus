# ADR-0040: DNS Consensus Fallback Parity

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-07 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0002, ADR-0039 |
| **Project** | DOMINUS |

## Context

The 2-of-3 DNS consensus gate introduced by ADR-0039 only ran on the
`DnsPreFilterStage` bulk-success path and the cross-validation-recovered
path. When the bulk check failed entirely (`checkBulk` throws or returns a
mismatched count), `#perDomainFallback` resolved every candidate through the
primary provider alone and returned the verdicts **without** asking the
secondary provider for confirmation.

The effect was an ADR-0002 asymmetry that depended on the *happy path* of
the transport layer:

> A candidate that reached the retry path received a verdict resting on a
> single provider's opinion, while the identical candidate on the bulk path
> received a two-independent-opinion verdict.

Bulk failures are not exotic — they are exactly what happens under network
saturation, a temporarily unavailable resolver group, or a Redis rate-limiter
`RateLimiterWaitTimeoutError`. In other words, the availability guarantee
weakened precisely then the run was under stress, which is the moment the
engine must be strictest, not laxest (ADR-0002 conservatism).

A secondary symptom: fallback-path runs never produced `verified` /
`disagreed` / `unverifiable` tallies or the `consensus-unverified`
degradation signal, so a run that silently lost its guarantee was
indistinguishable from one that genuinely had no eligible domains (the
ADR-0039 "silent throughput collapse" failure mode, reappearing at the
fallback layer).

## Decision

**Consensus is now applied on every resolution path.** `#resolveBulkWithFallback`
routes every degraded exit through a single helper,
`#fallbackWithConsensus`, that runs the per-domain fallback and then the
same strict 2-of-3 cross-check (`#applyConsensusIfConfigured`) used on the
bulk path:

- A per-domain verdict of `Available` from the fallback is only final when
  the secondary provider independently confirms it.
- A secondary failure (reject/`Unknown`/throw) downgrades the candidate to
  `Unknown`, and is counted in `consensusStats` / the degradation signal
  exactly as on the bulk path.
- Stages configured without a secondary (consensus disabled) behave
  exactly as before — `#applyConsensusIfConfigured` is a no-op.

### Options considered and rejected

- **Accept primary-opinion verdicts on the fallback path (status quo)** —
  rejected: it is the ADR-0002 gap being closed, and it only manifested on
  the degraded path of a degraded network layer.
- **Abort the run instead of falling back when the bulk check fails** —
  rejected: the bulk failure is typically transient and the primary check is
  still a legitimate fast signal (ADR-0039 rationale); aborting forfeits the
  run over a retryable transport hiccup.
- **Only log a warning without downgrading** — rejected: a warning does not
  enforce the conservatism principle; the verdict itself must not rest on a
  single provider.

## Consequences

### Positive

- ADR-0002 parity across **all** resolution paths: a bulk failure can no
  longer strip the two-provider availability guarantee.
- Fallback runs produce the same `consensusStats` and degradation signals as
  bulk runs, so degraded output is visible to operators (ADR-0039 machinery
  is preserved on the fallback layer).
- Single source of truth: the consensus entry point is one helper used by
  every exit of `#resolveBulkWithFallback`.

### Negative

- On a genuinely sick secondary, a run whose bulk check failed will now see
  all Available verdicts downgraded to `Unknown` (fail-closed is the desired
  outcome; there is no throughput win to re-claim).
- Adds one round of consensus queries on an already-degraded path, marginally
  extending wall-clock where the fallback was already slow.

### Risks and mitigation

- **Regression risk in fallback timing:** the fallback path now runs an extra
  consensus pass with the same `fallbackConcurrency` bound; the pass is
  bounded per-query by the provider timeouts that already cover the bulk
  path. Monitoring series (`dominus_dns_consensus_*`) expose whether
  fallback-downgraded runs are becoming frequent.