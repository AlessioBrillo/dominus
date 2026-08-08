# ADR-0045: DNS Consensus Third Leg

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-08 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0002, ADR-0039, ADR-0042, ADR-0044 |
| **Project** | DOMINUS |

## Context

The 2-of-3 DNS consensus gate (ADR-0039) demands a second, independent
resolver opinion before any `Available` verdict stands. Its failure policy is
fail-closed: when the secondary cannot answer, the domain is downgraded to
`Unknown` rather than trusted (ADR-0002 conservatism). That is the correct
bias for correctness — but it is also the gate's single point of failure:

- **The secondary's outage is the gate's outage.** ADR-0042 moved the
  secondary to a co-hosted recursor (Unbound) precisely to insulate it from
  public DoT egress, but a single leg still separates every `Available`
  verdict from `Unknown` on *any* secondary failure mode: local recursor
  crash, network partition to it, rate-limit exhaustion (ADR-0044), or a
  transient bulk failure.
- **A dead secondary converts availability research into a false negative.**
  With consensus enabled, a run over a live but silent secondary emits
  `Unknown` for domains that are almost certainly available — the user passes
  on acquisitions the tool would otherwise recommend. The gate is
  conservative, but it is *wastefully* conservative when the failure is a
  transient resolver problem rather than a genuine disagreement.
- **Consensus failures are already surfaced** via degraded-run flagging
  (`DNS_CONSENSUS_DEGRADED_RATIO`, ADR-0039) and the `DnsConsensusStats`
  verdict tallies, but nothing *acts* on them mid-run: degraded metrics tell
  the operator after the fact what the gate could not distinguish — a
  domain-level rescuing third opinion can.

What the existing design deliberately lacks is a **third, independent opinion
that may confirm what the secondary failed to confirm**. Two resolvers form
the minimum failing configuration; three end the single-point-of-failure on
the verification gate's own leg. The confidence cost is zero — a third
opinion confirms or vetoes; it can only rescue verdicts the gate would
otherwise drop.

## Decision

Add an optional **tertiary consensus leg** (ADR-0045), applied inside the
existing 2-of-3 consensus check on `Available` domains:

1. **Config, opt-in** — `DNS_TERTIARY_ENABLED` (default `false`); the leg is
   off by default and participates only when explicitly enabled.
   `DNS_TERTIARY_STRATEGY` (same strategy enum as the secondary, default
   `'native'` — the system recursor) and `DNS_TERTIARY_NAMESERVERS`
   (optional; when set, pins the leg to plain native DNS through those
   addresses, mirroring ADR-0042's C3 pinning rule) select its resolver set.
2. **A third opinion only.** The tertiary is consulted **only when the
   secondary cannot answer** (`requiredAvailable > secondary confirmations`).
   When the secondary confirms, the tertiary is never queried — it adds no
   cost to the happy path and no opinion when the gate already has one.
   When the secondary says `Registered`, the veto is final and the tertiary
   is never consulted.
3. **Rescue semantics.** A domain the tertiary resolves as `Available`, and
   whose leg count still falls short of `DNS_CONSENSUS_REQUIRED_AVAILABLE`
   (default `1`), is upgraded from `Unknown` to `Available` — `Verified`
   with `tertiaryRescued` set. A `Registered` answer blocks the domain
   (counts as disagreement → `Unknown`, never rescued). An unanswered leg
   count of 2 leaves the domain at its conservative fallback — it now costs
   *two* independent legs before an `Unknown` is manufactured.
4. **Strict independence, startup-checked.** The tertiary is built by
   `BuildTertiaryConsensusProvider` in the composition root. Its resolver
   endpoint set must be disjoint from *both* the primary and the secondary.
   Overlapping configuration (the same recursors backing two legs) removes
   the third opinion's independence, so the leg is dropped at startup with a
   warning — the gate must never silently thin its redundancy by racing the
   same endpoints twice. See ADR-0042 for why resolver-set overlap is treated
   as disabled rather than *undesired*.
5. **Bounded effort.** The tertiary consults the same dedicated
   consensus rate-limiter budget (ADR-0044), bounded by the same
   `DNS_CONSENSUS_BULK_CONCURRENCY` ceiling; it can never outrun
   or starve the secondary.
6. **Metrics.** `DnsConsensusMetrics` gains `tertiaryRescuedTotal`
   (resolves rescued *by* the tertiary), emitted as
   `dominus_dns_consensus_tertiary_rescued_total` (counter) in Prometheus,
   and the run-level stats carry `tertiaryRescued` on the affected domain.
7. **`DNS_CONSENSUS_REQUIRED_AVAILABLE` (default `1`, range 1–2) tightens the
   gate further.** With `1`, one confirmation — primary plus either the
   secondary or the tertiary — stands as `Available`; with `2`, both the
   secondary *and* the tertiary must confirm an `Available` verdict. When no
   tertiary leg is configured, `2` degrades gracefully to `1` at run time
   (with a one-time warning) rather than manufacturing `Unknown`s for the
   whole run. This restores, in effect, ADR-0039's strict-2 confirmation for
   operators who want it, while keeping the default cheap and independent.

## Consequences

### Positive

- **Single-point-of-failure removed from the confirmation leg.** A
  transient secondary outage no longer manufactures a run of false `Unknown`s:
  the tertiary rescues precisely the domains the gate intended to pass.
- **No happy-path cost.** The tertiary is only queried when the secondary
  cannot confirm — zero added latency/cost (after the disjointness check) on
  the confirmation path.
- **Veto stays absolute.** `Registered` from any consulted leg is final:
  rescue only ever *restores* availability; it can never overturn a
  registration verdict.
- **Operational observability** — `dominus_dns_consensus_tertiary_rescued_total`
  names the failure mode directly: a rising rescue tally is a secondary-leg
  outage in progress, visible without chasing logs.

### Negative

- **Three DNS opinions cost ~1 more query per rescued domain which the
  gate would have dropped anyway.** The rate-limiter budget bounds it.
- **New config surface** (four environment variables) and a startup-time
  disjointness check with no runtime re-dial: a misconfigured tertiary is
  dropped once, at boot, not saned mid-run.
- **Rescue tallies are a separate counter, not mixed into verified.**
  `verifiedTotal` keeps its strict meaning (secondary-confirmed only);
  rescued verdicts live exclusively in `tertiaryRescuedTotal`, and the
  run-level `tertiaryRescued` field is emitted only when > 0.

### Risks and mitigation

- **Rescued tallies can be mistaken for strict-two-opinion confirmations.**
  With `DNS_CONSENSUS_REQUIRED_AVAILABLE=1` (default), a rescued domain was
  confirmed by the primary + tertiary, not the primary + secondary. The
  metric naming captures this (`tertiary_rescued_total`), and the default
  stays `1`; operators who need strict two-opinion confirmation set it to
  `2`, where a domain counts only with both secondary *and* tertiary.
- **Triple redundancy tanks cost.** The geometry that makes the leg useful
  (secondary silent) is rare by definition; doubling the DNS budget for it
  would violate the conservatism gate's cost discipline — mitigate: shared
  budget, disabled by default, only consulted on failure.

### Related ADRs

- ADR-0002 (scoring conservatism — the gate under guard)
- ADR-0039 (2-of-3 consensus degradation policy)
- ADR-0042 (private recursor as the consensus secondary — C3 pinning reused)
- ADR-0044 (dedicated consensus budget — budget the tertiary must share)