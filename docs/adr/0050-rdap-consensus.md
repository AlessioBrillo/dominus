# ADR-0050: RDAP Consensus — Independent Second Opinion on Availability

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0002, ADR-0035, ADR-0039, ADR-0044, ADR-0045, ADR-0049 |
| **Project** | DOMINUS |

## Context

`FailoverRdapProvider` returns the *first definitive answer in input order*
from a race across the TLD's authoritative registry (IANA bootstrap, RFC
7484) and the rdap.org universal fallback. A single server's verdict is
trusted without an independent second opinion:

- a stale IANA bootstrap entry pointing at a defunct registry endpoint,
- an anomalous 404 (caching layer, registry bug, MITM) from the
  authoritative server, or
- a 404 from rdap.org routing the wrong way

is accepted as `Available` with no counter-evidence. The only current
cross-check is the WHOIS bounded enrichment in the RDAP stage (ADR-0035) —
WHOIS is port-43, unencrypted, and heavily rate-limited, the weakest channel
in the stack. DNS solved the same problem with a strict 2-of-3 consensus
(ADR-0039/0040/0045); RDAP deserves the equivalent on its own channel.

RDAP differs structurally from DNS: there is **one** authoritative source per
TLD (the registry), not three interchangeable resolvers. The natural second
opinion is the rdap.org universal routing server, which answers any TLD and
already participates in the race. A genuine third independent opinion for RDAP
does not exist at acceptable cost, so the gate is **2-of-2**, not 2-of-3.

## Decision

Add an optional **2-of-2 RDAP consensus gate** on the `Available` subset,
opt-in via `RDAP_CONSENSUS_ENABLED` (default `false`):

1. **Gate semantics (fail-closed).** When enabled, the primary failover
   verdict for a domain is `Available` only if both the primary (authoritative
   registry + rdap.org race) **and** an independent second provider confirm.
   The second provider is a dedicated `PublicRdapProvider` on rdap.org built
   from the same bootstrap/endpoint configuration, but consulted separately.
   - Any `Registered` from either leg **vetoes** absolutely (ADR-0002
     "registered wins", mirroring ADR-0045).
   - Disagreement or failure to answer (error/timeout/Unknown) on the second
     leg downgrades the domain to `Unknown` — never to `Available`.
   - `Registered` verdicts are **not** re-verified (already the conservative
     outcome) — the gate only re-checks the risky `Available` subset, exactly
     like DNS.
2. **Endpoint disjointness.** `RDAP_BOOTSTRAP_URLS` configured by the
   operator is validated at startup: duplicate origins or a second provider
   whose endpoint set overlaps the primary's would make the "second opinion"
   a rubber stamp. Overlap logs an error and disables the consensus with a
   clear message (mirroring `validateConsensusEndpointDisjointness`).
3. **Dedicated consensus budget.** The second RDAP leg draws from its own
   token bucket (`RDAP_CONSENSUS_RATE_LIMIT_*`, default 5 req/sec, burst 5)
   in its own Redis namespace (`rdap-consensus`), mirroring ADR-0044 §1.
   A heavy primary run can never starve the very gate meant to fail it
   closed, and vice versa.
4. **Independent concurrency ceiling.** `RDAP_CONSENSUS_BULK_CONCURRENCY`
   (default 10, range 1–50) bounds the verification phase separately from
   `RDAP_BATCH_CONCURRENCY`, so a stampede cannot multiply registry traffic.
5. **Degraded-run flagging.** When the secondary cannot verify more than
   `RDAP_CONSENSUS_DEGRADED_RATIO` (default 0.5) of a minimum
   `RDAP_CONSENSUS_DEGRADED_MIN` (default 10) confirmed-Available domains,
   the run completes but is flagged `rdap-consensus-unverified` in
   `degradedReasons` and exposes `dominus_rdap_consensus_*` metrics
   (ADR-0039 pattern). Small runs below the minimum never flag.
6. **Startup probe.** When enabled, the second leg is probed at boot
   (mirroring `probeConsensusProvider`); a dead secondary is logged
   prominently because strict fail-closed semantics would downgrade every
   `Available` to `Unknown`.
7. **WHOIS cross-validation is unchanged** (ADR-0035): WHOIS remains a
   bounded enrichment and extra conservative check; RDAP consensus is an
   additional gate, not a replacement.

`RDAP_CONSENSUS_REQUIRED_AVAILABLE` is fixed at 1 (one independent
confirmation beyond the primary). There is no RDAP tertiary leg: no third
genuinely independent channel exists at acceptable cost, and a fabricated
third leg would add latency without real redundancy (unlike DNS ADR-0045,
where a pinned recursor is a genuinely independent resolver).

### Implementation notes (2026-08-09)

- **Second leg is operator-pinned, not rdap.org by default.**
  `RDAP_CONSENSUS_ENDPOINT` (https-only, default **empty**) names the
  independent origin; rdap.org as the default was dropped because for the
  TLDs the primary already races against the registry it would converge back
  onto the primary's infrastructure (a rubber stamp). Empty endpoint with the
  gate enabled disables the gate at boot with a prominent warning — the gate
  never silently degrades into single-leg verdicts.
- **The gate rides on the stage, not the providers.** `RdapConfirmationStage`
  re-confirms the primary `Available` subset through an `rdapConsensusConfig`
  (secondary provider, degraded ratio/min, concurrency ceiling). Fail-closed:
  a definitive `Registered` from the second leg vetoes the domain, an
  unverifiable second leg (error/timeout/Unknown) downgrades it to `Unknown`
  — never `Available`. Covers both provider paths (cached and fresh closeout
  lookups).
- **Factory boundaries locked by regression tests.** `composition-root` wires
  the gate through `createRdapConsensusConfig`, which builds a dedicated
  failover provider pinned to `RDAP_CONSENSUS_ENDPOINT` with its own keyed
  agent pool, per-server circuit breakers, and the `rdap-consensus` budget
  (`rdapConsensus` in `buildRateLimiters`).
- **`RDAP_CONSENSUS_REQUIRED_AVAILABLE`** was implemented in the first pass
  then removed: it was dead config — the semantics are fixed 2-of-2, and a
  knob that cannot change the outcome is a trap. Removed from schema, docs
  and fixtures in the same change (decision above holds).

### Options considered and rejected

- **Status quo (single authoritative verdict + WHOIS)** — rejected: WHOIS is
  the least trustworthy channel and the authoritative registry can still
  publish a wrong 404 that becomes a false `Available`.
- **Default-on like DNS** — rejected for cost: a second HTTP query for every
  `Available` roughly doubles RDAP volume and registry rate-limit pressure.
  The DNS gate is default-on because the DNS volume is bounded and cheap;
  RDAP hits real registries with 429 behaviour. Opt-in preserves the
  conservative default while making the gate available.
- **2-of-3 with a fabricated third leg** — rejected: no independent third
  RDAP channel; a redundant-but-identical opinion is rubber-stamping.
- **Vote-based majority over two legs** — rejected: with two legs a majority
  is meaningless; the fail-closed `Unknown` on disagreement is the only
  conservative outcome consistent with ADR-0002.

## Consequences

### Positive

- `Available` verdicts are no longer single-server; an anomalous 404 from the
  authoritative registry or rdap.org is caught by the other leg.
- The gate is opt-in, budgeted, concurrency-bounded, probe-tested, and
  observable — no regression for existing deployments, full parity with DNS
  when enabled.
- WHOIS enrichment and conservatism remain intact (ADR-0035).

### Negative

- Doubles RDAP queries on the `Available` subset when enabled (opt-in).
- Second token bucket can queue even when the primary has spare capacity —
  latency, not correctness.
- A dead secondary (when enabled) downgrades `Available` verdicts to
  `Unknown` until fixed — surfaced at boot by the probe and in runs by the
  degraded flag.

### Risks and mitigation

- **rdap.org as single point of failure for the second leg**: the gate is
  opt-in; operators that route everything through custom `RDAP_BOOTSTRAP_URLS`
  can supply a second distinct origin, and disjointness validation ensures it
  is genuinely different.
- **Consensus latency** on busy runs: `RDAP_CONSENSUS_BULK_CONCURRENCY` and
  the per-domain timeout bound the verification phase wall clock.

### Related ADRs

- ADR-0002 (scoring conservatism — "registered wins" and fail-closed)
- ADR-0035 (RDAP authoritative bootstrap — the servers under verification)
- ADR-0039 (consensus degradation policy — the flag pattern reused)
- ADR-0044 (dedicated consensus budget — the budget pattern reused)
- ADR-0045 (DNS tertiary leg — explicitly NOT mirrored for RDAP)
- ADR-0049 (RDAP transport parity — the transport layer this gate rides on)
