# ADR-0060: RDAP Origin-Guard Fail-Closed — a Broken Resolver Never Consults the Second Leg

## Metadata

| Field          | Value                                            |
| -------------- | ------------------------------------------------ |
| **Status**     | Accepted                                         |
| **Date**       | 2026-08-17                                       |
| **Authors**    | AlessioBrillo                                    |
| **Deciders**   | AlessioBrillo                                    |
| **Supersedes** | N/A                                              |
| **Relates to** | ADR-0002, ADR-0039, ADR-0050, ADR-0051, ADR-0058 |
| **Project**    | DOMINUS                                          |

## Context

ADR-0058 introduced the per-TLD origin-overlap guard for the RDAP 2-of-2
consensus gate: before consulting the second leg, the stage resolves the
candidate TLD's authoritative RDAP origins (IANA bootstrap, rdap.org
excluded) and skips the second opinion — downgrading the verdict as
unverifiable — whenever the second leg's origin is authoritative for that
TLD. The guard exists to stop a rubber stamp: with the default `rdap.org`
second leg, an authoritative registry answering the primary query could
confirm its own verdict and pass a wrong "Available" straight into scoring.

The guard's resolver failure path was **fail-open**. `resolveAuthoritativeOrigins`
caught every rejection from the resolver and returned `undefined` — the same
value used for "guard not configured" — logging "origin-overlap check skipped
for the TLD" and proceeding to consult the second leg. When the IANA
bootstrap is unreachable (network partition, DNS failure, API outage), the
guard cannot prove the second leg is disjoint from the TLD's authoritative
origins; consulting it can produce exactly the rubber-stamp verdict the guard
exists to prevent. ADR-0002 mandates conservatism: the engine must be more
conservative than the commercial appraisers, not more generous. A guard that
disarms itself on the very outage it is meant to protect against violates
that principle and the ADR-0039 fail-closed posture the DNS and RDAP gates
already follow.

## Decision Drivers

1. **Conservatism (ADR-0002)** — "more conservative, never more generous";
   a rubber-stamped second opinion must not pass under any failure mode.
2. **Fail-closed parity (ADR-0039/ADR-0050/ADR-0058)** — the RDAP gate
   already downgrades on second-leg errors and timeouts; a resolver failure
   is the same class of uncertainty and must behave identically.
3. **Distinguishable semantics** — "guard not configured" (operator chose no
   guard) and "guard configured but broken" (operator expects protection)
   must not collapse into one value; the latter must fail closed.
4. **Observability** — guard failures must be countable separately from
   generic unverifiable verdicts, so degraded runs are attributable
   (ADR-0039 degradation flagging).

## Considered Options

### Option A: Fail-closed resolver handling (chosen)

A resolver rejection propagates to the per-candidate handler, which skips
the second leg, increments `unverifiable` and a new `originGuardUnavailable`
counter, and downgrades the candidate to `Unknown` (filtered). Only an
explicitly unconfigured resolver — or an unparsable secondary endpoint,
which cannot prove overlap (ADR-0058 stance on typos) — preserves the
consult-the-second-leg behaviour. A new Prometheus series
`dominus_rdap_consensus_origin_guard_unavailable_total` and a matching field
on the JSON snapshot make failures attributable; the existing degraded-run
flagging (unverifiable ratio) covers the run-level signal automatically.

- **Pros**: rubber stamp impossible on resolver failure; semantics of
  `undefined` stay "guard off, operator's choice"; zero-config deployments
  unaffected; new counter surfaces the failure mode.
- **Cons**: an IANA bootstrap outage now degrades Available verdicts for
  every affected TLD (the intended conservative cost); requires updating the
  ADR-0058 test that documented the fail-open behaviour.

### Option B: Cache the failure and keep consulting the second leg (status quo)

The resolver failure is logged once per TLD and the second opinion proceeds
unchecked, as today.

- **Pros**: no behaviour change; verdicts survive bootstrap outages.
- **Cons**: the guard disarms on the exact outage class it protects against;
  a rubber-stamped "Available" can reach scoring; violates ADR-0002 and the
  fail-closed posture of ADR-0039/0050/0058.

### Option C: Resolver failure forces a re-check through WHOIS

Instead of skipping the second leg, route the candidate through the WHOIS
rescue leg (ADR-0051) regardless of the rescue flag.

- **Pros**: a second opinion still happens, via an independent channel.
- **Cons**: conflates two gates; requires WHOIS to be wired; the WHOIS rescue
  is opt-in by design (ADR-0051) and forcing it changes billing/egress
  characteristics; more complex than the failure warrants.

## Decision

Option A. The guard's resolver failure is fail-closed: the second leg is
never consulted when the guard cannot prove disjointness, the verdict is
downgraded as unverifiable, and the failure is counted in a new
`originGuardUnavailable` tally surfaced on the Prometheus endpoint.

## Consequences

### Positive

- A broken IANA bootstrap cannot smuggle a rubber-stamped second opinion
  into scoring — the conservative posture holds under outage.
- Guard state is unambiguous: `undefined` means "operator disabled the
  guard", never "guard failed".
- The failure is observable (new counter + JSON field) and participates in
  the existing degraded-run flagging.

### Negative

- A bootstrap outage now downgrades every Available verdict in affected
  TLDs until the resolver recovers — reduced yield during outages, the
  deliberate price of the conservative default.

### Neutral

- The ADR-0058 stage test documenting the fail-open path was rewritten to
  assert the fail-closed behaviour.
