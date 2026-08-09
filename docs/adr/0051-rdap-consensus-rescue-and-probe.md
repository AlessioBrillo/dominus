# ADR-0051: RDAP Consensus Rescue Leg and Startup Probe — Closure of ADR-0050 Gaps

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-10 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A (alters ADR-0050 §1 fail-closed rule in one opt-in mode) |
| **Relates to** | ADR-0002, ADR-0035, ADR-0039, ADR-0045, ADR-0049, ADR-0050 |
| **Project** | DOMINUS |

## Context

ADR-0050 shipped the opt-in 2-of-2 RDAP consensus gate, but three gaps
surfaced during the hardening review:

1. **The startup probe was never implemented.** ADR-0050 §6 promises a boot
   probe of the second leg, mirroring `probeConsensusProvider` in the DNS
   layer (ADR-0045); `composition-root` only probes the DNS secondary. A dead
   second leg is therefore discovered at the first degraded run, not at boot.
2. **`RDAP_CONSENSUS_TIMEOUT_MS` is dead config.** Defined in the schema
   (default 10000) with test fixtures locking it, but `createRdapConsensusConfig`
   never passes it to the consensus provider, which hardcodes
   `DEFAULT_RDAP_TIMEOUT_MS`. The knob cannot be tuned and docs drift from
   behaviour.
3. **The 2-of-2 gate has no rescue path.** ADR-0050 §4 explicitly rejected a
   fabricated third RDAP leg, but left the gate binary: a second leg that is
   flaky (registry slowness, transport errors, rate limiting) or down
   downgrades every `Available` to `Unknown`. DNS solved this exact problem
   with the ADR-0045 tertiary rescue; RDAP has no equivalent. Fail-closed is
   correct, but a gate that cannot distinguish "second leg vetoed" from
   "second leg was down" converts a provider outage into silent run-wide
   filtering.

The unique structural fact is unchanged: RDAP has one authoritative source
per TLD, so a *third RDAP channel* would be a rubber stamp. But the
WHOIS bounded enrichment already racing inside the stage (ADR-0035) is a
second, genuinely different channel — port 43, different operator, different
failure modes. It is the weakest channel, but it is already paid for: the
stage runs it inside a 1s budget with zero extra volume when disabled.

## Decision

Close all three gaps in one change:

1. **Startup probe (gap 1).** Add `probeRdapConsensusEndpoint`, mirroring
   `probeConsensusProvider` (DNS): when the gate is enabled, the second leg
   is probed at boot with a known-domain query; a failure is logged
   prominently (non-fatal, gate stays enabled, run-level degraded flags
   still apply). The probe runs from the factory wiring in `composition-root`.

2. **Wire the timeout (gap 2).** `FailoverRdapProvider.fromConfig` gains an
   optional `timeoutMs` (default `DEFAULT_RDAP_TIMEOUT_MS`); the RDAP
   consensus factory passes `config.RDAP_CONSENSUS_TIMEOUT_MS`. The primary
   leg is untouched — only the second leg honors the knob.

3. **Opt-in WHOIS rescue leg (gap 3).** New flag
   `RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED` (default `false`). When enabled and
   a WHOIS provider is configured, candidates whose *second leg cannot
   answer* (`error`/`timeout`/`Unknown`) are re-checked through WHOIS within
   the same bounded budget as the stage's normal WHOIS race:
   - WHOIS `available` → verdict confirmed, counted `verified` and
     `tertiaryRescued` (new `RdapConsensusStats` field, mirroring DNS).
   - WHOIS `registered` → veto, counted `disagreed` — "registered wins"
     (ADR-0002) and a rescue can never create an `Available`.
   - WHOIS timeout/error → stays `unverifiable` → `Unknown` (unchanged).
   - A *definitive Registered from the second RDAP leg* remains a final
     veto — the rescue leg is never consulted on a veto (ADR-0050 §1).
   - Degradation accounting is unchanged (ADR-0039): rescues reduce the
     `unverifiable` numerator, so a healthy WHOIS backstop can itself clear
     the degraded flag.

   This is a **narrow, opt-in override** of ADR-0050 §1's "failure to answer
   downgrades to Unknown — never Available": it applies only to the
   unverifiable class, never to disagreements, and only when the operator
   explicitly enables the flag. The default posture remains fully
   fail-closed.

### Options considered and rejected

- **Status quo (binary 2-of-2).** Correct conservatism; unusable when the
  second leg flakiness is transient — exactly the case consensus should
  absorb. Rejected as the end state; kept as the default mode.
- **Third RDAP leg.** Rejected in ADR-0050 (rubber stamp); re-rejected here.
- **WHOIS rescue on disagreements.** Rejected: a WHOIS `available` must never
  counter a second-leg `Registered` — "registered wins" is absolute.
- **Default-on rescue.** Rejected: WHOIS is the weakest channel; defaulting
  to a weaker backstop would silently relax the gate on every default
  install. The rescue is an operator decision.

## Consequences

### Positive

- Operator discovers a dead second leg at boot, not after N degraded runs.
- `RDAP_CONSENSUS_TIMEOUT_MS` becomes tunable end-to-end; docs and schema
  converge.
- A transiently failing second leg no longer empties the `Available` set:
  the WHOIS channel rescues only the verifiable class, still vetoed by any
  `Registered`. Zero extra query volume when disabled.

### Negative

- `unverifiable → Available` is now reachable under an explicit opt-in —
  a conscious trade of a sliver of fail-closed strictness for resilience.
- Rescue queries draw from the WHOIS port-43 budget on the rescued subset
  only (the stage's existing rate limiter is shared); on a heavy run the
  rescued subset competes with WHOIS enrichment volume.

### Risks and mitigation

- **False Available via WHOIS "no match" on a registered domain.** A WHOIS
  "not found" for a registered domain is rare (registrar WHOIS privacy
  changes this; mitigated by the second-leg veto already having failed).
  Acceptable residual risk under explicit opt-in; measurable via
  `tertiaryRescued` vs `disagreed` tallies.
- **WHOIS floods on gate outages.** The rescue is bounded by the same
  concurrency ceiling (`RDAP_CONSENSUS_BULK_CONCURRENCY`) and the 1s budget;
  it never adds unbounded per-candidate traffic (the race is sequential over
  the rescued subset).

### Related ADRs

- ADR-0002 (conservatism — "registered wins", fail-closed default)
- ADR-0035 (RDAP authoritative bootstrap; WHOIS bounded enrichment)
- ADR-0039 (consensus degradation policy — accounting unchanged)
- ADR-0045 (DNS tertiary rescue — the pattern mirrored, adapted to WHOIS)
- ADR-0049 (RDAP transport parity — the transport the gate rides on)
- ADR-0050 (RDAP 2-of-2 consensus — the gate this ADR closes the gaps on)