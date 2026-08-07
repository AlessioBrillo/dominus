# ADR-0039: DNS Consensus Failure Policy

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-07 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0002, ADR-0035, ADR-0037 |
| **Project** | DOMINUS |

## Context

The DNS pre-filter uses a 2-of-3 resolver consensus: the primary bulk check
races multiple resolvers internally, and every `Available` verdict is
cross-checked against an independent secondary provider before it is
accepted. This exists to uphold the ADR-0002 conservatism principle — a
domain must never pass on the opinion of a single resolver.

The consensus check has an operating condition that is outside DOMINUS'
control: the secondary must actually *answer*. When a secondary provider is
briefly down, rate-limited, or selecting an overloaded resolver, every
Available verdict becomes unverifiable and the whole run is downgraded to
`Unknown` — and thus filtered. Two failure modes result:

1. **Silent throughput collapse**: nothing in the run result told the user
   *why* everything was filtered. A run with 500 candidates and a sick
   secondary produced 0 recommendations indistinguishable from a genuine
   "no eligible domains" verdict.
2. **Hard outage vs. degraded warning**: the alternative — aborting the run
   when consensus fails — is disproportionate. The primary DNS check is still
   a legitimate fast signal; discarding the whole run lazily loses all
   candidates because one secondary hiccupped. But blindly accepting
   primary-only verdicts violates ADR-0002.

A third constraint complicates the threshold: on small runs (a handful of
candidates), a single unverifiable response is a large fraction. Without a
floor, one bad resolver response would flag the run degraded over a domain or
two — a false alarm that makes the degradation signal meaningless.

## Decision

**Fail-closed with a visible flag.** When the secondary cannot confirm a
material share of the primary's `Available` verdicts:

- Every unconfirmed domain is downgraded to `Unknown` and filtered (existing
  ADR-0002 behaviour — consensus is strictly required; no single-resolver
  domains pass).
- The run **continues** but is flagged **degraded**, surfacing an explicit
  `consensus-unverified` `StageDegradation` on the run so it is never
  confused with a genuine no-recommendations run (ADR-0037 machinery).
- Degradation fires only when both conditions hold:
  - `unverifiable / consensusTotal >= degradedRatio` (default 0.5 — the
    secondary failed majority), **and**
  - `consensusTotal >= degradedMin` (default 10) — small runs never flag.
- The verdict tally (`verified`, `disagreed`, `unverifiable`, `degraded`)
  is carried per run to the metrics collector and exposed as
  `dominus_dns_consensus_*` Prometheus series.

### Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `DNS_CONSENSUS_DEGRADED_RATIO` | `0.5` | Minimum fraction of unverifiable verdicts (over consensus-checked domains) that flags degradation |
| `DNS_CONSENSUS_DEGRADED_MIN` | `10` | Minimum consensus-checked domains before degradation can be flagged |

These join the existing `DNS_CONSENSUS_SECONDARY_PROVIDER` knob and are read
in `src/config.ts`, threaded through the provider factory into the
`ConsensusDnsConfig` consumed by `DnsPreFilterStage` (`src/pipeline/stages/dns-prefilter-stage.ts`).

### Options considered and rejected

- **Fail-open (accept primary-only verdicts on consensus failure)** — rejected:
  lets a domain through on a single resolver's opinion, directly violating the
  ADR-0002 conservatism principle that this consensus exists to enforce.
- **Fail-closed and silent (filter everything, no flag)** — rejected: produces
  the silent-throughput-collapse failure mode that motivated this ADR. Output
  that rests on a single (or sick) resolver must be visible.
- **Hard abort of the run** — rejected: one secondary hiccup would forfeit
  otherwise valid candidates; the primary check is a legitimate fast signal and
  ADR-0037 already provides a proper degraded-run channel.
- **Always flag on any unverifiable** — rejected: noisy on small runs, which
  now the `degradedMin` floor exists to protect.

## Consequences

### Positive

- The consensus check stays strict: no domain passes on a single resolver —
  the ADR-0002 principle is preserved even when the secondary is sick.
- Degradation is loud: the ADR-0037 `degradedReasons` channel, job/API/CLI
  surface and dashboard banner now distinguish "degraded run" from "no
  recommendations", with a human-readable message (`X/N Available verdicts
  unconfirmed by the secondary provider`).
- Tunable via config without a code change; sane defaults keep tiny runs quiet.
- Verdict tallies are observable: `verified`/`disagreed`/`unverifiable`
  counters plus a degraded-run gauge in `/metrics` (and the collector
  snapshot), so an operator can detect a chronically sick secondary.

### Negative

- A genuinely unavailable, valuable, non-trademarked domain is still dropped
  when the secondary can't confirm it — consensus is conservative by design.
- With defaults, a run with 9 or fewer consensus-checked domains never flags
  degraded even at 100% unverifiable (7 falses), trading strictness for
  noise-free small runs — an explicit, documented trade-off.
- One more config surface to tune (ratio/min), mitigated by the default
  majority + floor pairing.

### Risks and mitigation

- **False security from a healthy secondary**: the consensus gate is only as
  good as the secondary's independence; the metrics series now expose
  repeated `disagreed`/`unverifiable` spikes for monitoring.
- **Threshold tuning**: if real-world secondaries degrade proportionally lower
  than the default `0.5`, operators should lower the ratio; the series
  provide the data to decide.