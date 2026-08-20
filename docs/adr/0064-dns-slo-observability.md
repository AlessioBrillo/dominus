# ADR-0064: DNS SLO Observability — per-leg latency histograms and tertiary rescue in the production topology

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-20 |
| **Authors** | Alessio Brillo |
| **Deciders** | Alessio Brillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0002, ADR-0039, ADR-0042, ADR-0044, ADR-0045, ADR-0046, ADR-0059, ADR-0063 |
| **Project** | DOMINUS |

## Context

The DNS consensus gate (ADR-0039, ADR-0045) makes every Available verdict
rest on up to three resolver opinions: a primary multi-resolver strategy, a
consensus secondary, and — since ADR-0045 — an optional tertiary. The gate
is conservative by construction (ADR-0002): a slow or dead leg downgrades
verdicts to Unknown, never to fabricated Availability. What the gate could
not do was tell the operator *why* a run degraded: which leg stalled, which
endpoint, and for how long. Provider call counters and breaker state
(ADR-0059) only surfaced binary health; latency shape — the p99 of a leg
creeping toward the 1.5s lookup timeout — was invisible until verdicts
turned Unknown.

Separately, the documented production override
(`docker-compose.dns-consensus.yml`, ADR-0042) pins the consensus secondary
to a co-hosted Unbound recursor on a dedicated subnet. That makes the
secondary operator-independent of the primary's public resolvers, but it
also makes Unbound a single point of failure for the whole gate: if the
container dies, the secondary cannot answer, and every Available verdict is
downgraded to Unknown for the life of the outage. The tertiary leg existed
(ADR-0045) but was default-off and `native`-by-default — a configuration
that shares operators with the default `doh-primary` primary and is
therefore vetoed by the disjointness check. The turnkey topology had no
viable third opinion wired in.

This ADR records two related decisions: (1) feed per-leg DNS and per-request
RDAP latency into Prometheus histograms so SLO alerting can quantify
degradation, and (2) wire the tertiary into the production override using a
new `doh-alternate` strategy (Cisco OpenDNS) so the gate survives a dead
recursor.

## Decision Drivers

1. **SLO alerting needs latency, not just verdicts** — a resolver
   approaching its timeout is a leading indicator; Unknown verdicts are the
   lagging outcome. Without per-leg duration data no p99 alert can exist.
2. **The recursor is a consensus SPOF in the turnkey topology** — a dead
   Unbound container downgrades every Available verdict; the documented
   override must not ship a single point of failure for the gate.
3. **Zero-cost discipline (ADR-0001)** — OpenDNS DoH is free and keyless;
   the fix must add no paid API and no new infrastructure.
4. **Operator disjointness is non-negotiable (ADR-0063)** — the tertiary
   must be independent of the primary and the secondary at operator level,
   or the disjointness check vetoes it at boot.
5. **Conservatism (ADR-0002)** — telemetry must never change verdicts;
   hooks must be best-effort and abort-immune.

## Considered Options

### Option A: Histograms + `doh-alternate` tertiary in the override

Add a Prometheus histogram family (`dominus_dns_leg_duration_ms`) fed by a
per-leg telemetry hook on the DNS provider: every non-aborted resolver leg
emits one sample labelled by transport, endpoint (the breaker key), verdict
and role (primary/consensus/tertiary). The RDAP failover provider emits a
second family (`dominus_rdap_request_duration_ms`) labelled by server and
outcome. Both render through the existing `/metrics` endpoint in the text
exposition format. The bucket set spans 5ms to 30s so p50/p99 of both
transports and the RDAP timeouts are quantifiable. In parallel, a new
`doh-alternate` lookup strategy — a single DoH group against
`https://dns.opendns.com/dns-query` (RFC 8484 wire format, live-verified) —
is enabled as the tertiary in `docker-compose.dns-consensus.yml`, giving
the gate a fourth operator (Cisco) disjoint from the primary
(Cloudflare/Google/Quad9) and the pinned recursor.

**Advantages:**
- Directly serves both drivers: p99 alert rules can be written against the
  histograms, and the SPOF disappears with a two-line env change.
- No new dependencies, no paid APIs, no schema change; reuses the existing
  metrics collector, `/metrics` endpoint and Prometheus rules file.
- The telemetry hook is additive and best-effort: it cannot alter verdicts
  or take DNS down (ADR-0002 intact).
- OpenDNS is a genuinely fourth operator over a transport (DoH) the pinned
  recursor and native legs do not use, so the disjointness check passes in
  the override.

**Disadvantages:**
- Another operator dependency in the DNS path (a third-party resolver whose
  DoH endpoint could change or be geo-blocked).
- Label cardinality: endpoint labels multiply series; bounded because
  endpoints are a small fixed set and legs are low-volume.
- Histogram memory grows per unique label set for the process lifetime.

**Cost Implications:** ~1 day of implementation across provider, collector,
renderer, rules and tests. Zero operational cost (OpenDNS free tier,
keyless).

**Risk Assessment:** Low technical risk; the DoH endpoint was live-verified
at decision time. Vendor risk mitigated by the breaker (ADR-0059): if
OpenDNS degrades, the tertiary leg is skipped, never used to fabricate
verdicts. No migration risk — the tertiary is opt-in via the override.

---

### Option B: Histograms only, keep the recursor as sole secondary

Implement the latency observability but leave the override unchanged: no
tertiary, no `doh-alternate` strategy.

**Advantages:**
- Smallest change; no new DNS endpoint or operator to maintain.
- Alerts will at least *detect* a dying recursor (secondary leg p99 grows,
  Unavailable share rises).

**Disadvantages:**
- The recursor SPOF remains: detection without mitigation leaves every
  Available verdict downgraded during any recursor outage.
- No way to rescue verdicts; the gate degrades by design in the exact
  topology the override documents.
- Detecting a problem the product cannot route around is half a fix.

**Cost Implications:** ~0.5 day; the alerting alone.

**Risk Assessment:** Low technical risk, but the central production risk
(the SPOF) stays open.

---

### Option C: Replace the consensus secondary with a second public DoH strategy

Drop the pinned recursor from the override and let the secondary use a
public DoH/DoT strategy instead, removing the SPOF by removing the recursor.

**Advantages:**
- No private recursor to run or monitor; no dedicated container.

**Disadvantages:**
- Loses the operator-independence rationale of ADR-0042 (a co-hosted
  DNSSEC-validating recursor is the most independent opinion available).
- Any public strategy choice shares an operator with the primary
  (Cloudflare/Google/Quad9 are behind every mainstream resolver), which the
  disjointness check would veto — the gate would silently disable in the
  override, the exact failure ADR-0063 eliminated.
- Loses DNSSEC-validating local recursion for the primary's native leg.

**Cost Implications:** ~0.5 day; cheaper in code, more expensive in
architecture fidelity.

**Risk Assessment:** High architectural risk: would re-introduce the
ADR-0063 class of silent gate vetoes.

---

## Decision

**Chosen option: Option A — histograms + `doh-alternate` tertiary in the override.**

The histogram decision is unambiguous: latency data is the only way to turn
"verdicts turned Unknown" into an actionable SLO alert with a margin before
the failure. The bucket set (5ms–30s) is chosen so the same family covers
native/DoH/DoT legs (typical p50 5–50ms, timeout 1.5s) and RDAP requests
(timeout 10s), keeping two families instead of bespoke per-transport
buckets. The endpoint label uses the existing breaker key (ADR-0059) so
alert triage maps a slow leg straight to the circuit state that guards it.
Aborted legs are deliberately excluded from the samples: winner-child
aborts are scheduling artifacts, not resolver health signals, and would
skew percentiles downward with meaningless sub-millisecond points.

The `doh-alternate` strategy wins over Option C because it removes the SPOF
*without* removing the recursor: the recursor stays the secondary (its
ADR-0042 independence rationale is untouched), and the tertiary becomes an
independent public opinion consulted only when the secondary cannot answer
(ADR-0045 semantics). OpenDNS was chosen over other keyless DoH providers
after live verification (HTTP 200 on RFC 8484 `application/dns-message`,
2026-08-20); alternatives like `unicast.censurfridns.dk` returned 400 and
were rejected. It is the fourth operator in the default stack and the only
one whose DoH endpoint is not one of the three primary operators, so the
triple disjointness check (tertiary vs primary, tertiary vs secondary,
secondary vs primary) passes in the override — verified by a boot-equivalent
test that constructs the gate from the override env. Steady-state cost is
unchanged: the tertiary is consulted only when the secondary fails.

## Consequences

### Positive
- p99 latency alerts for DNS legs and RDAP requests become writable and
  quantifiable (rules added to `deploy/prometheus/rules.yml`: >2s DNS leg,
  >8s RDAP, breaker-open).
- The production override's gate survives a dead recursor: the tertiary
  rescues Available verdicts instead of downgrading them.
- Telemetry is additive and cannot alter verdicts (ADR-0002) — hooks are
  best-effort, abort-immune, and rate-limited to leg/request granularity.
- The boot-equivalent wiring test now covers the tertiary env, so a future
  overlap regression cannot silently disable the gate again (ADR-0063
  lesson).

### Negative
- One more external DoH dependency in the consensus path (OpenDNS); its
  failure is mitigated by the circuit breaker but adds a third-party
  availability dependency to the tertiary opinion.
- Histogram state grows with distinct label sets for the process lifetime;
  bounded by the fixed endpoint/verdict/role label domains, but the
  collector must be reset on restart (already the case).
- The `doh-alternate` strategy is a single-endpoint group by design — no
  fallback inside the group; a dead OpenDNS endpoint yields no tertiary
  opinion (the breaker skips it), not a fabricated one.

### Compliance and Security Implications
- All queries to OpenDNS are DNS lookups of candidate domains — the same
  data already sent to Cloudflare/Google/Quad9/Unbound in the default
  topology; no new data class.
- DNSSEC validation is unaffected: the tertiary is a plain DoH resolver
  opinion like the primary's legs; the recursor keeps its rigorous
  validation role for the native legs.
- No secrets, keys, or paid APIs involved.

### Migration and Monitoring Plan
- Rollout: code lands with the tertiary default-off (`DNS_TERTIARY_ENABLED=false`);
  only the production override turns it on. Existing deployments are
  unaffected until they adopt the override.
- Monitoring: `dominus_dns_leg_duration_ms` and
  `dominus_rdap_request_duration_ms` appear on `/metrics` immediately;
  alert rules fire at p99 > 2s (DNS) and > 8s (RDAP) sustained for 10m.
- Success criteria: alert rules fire before verdict degradation in a
  deliberate endpoint slow-down drill; the override survives a simulated
  recursor kill (secondary Unknown, tertiary rescues Available).
- Rollback: removing the two `DNS_TERTIARY_*` env lines from the override
  reverts to the pre-ADR behavior; the code path is env-gated and additive.

### Validation
- Unit tests: histogram bucketing/aggregation/reset in the collector,
  histogram rendering in the Prometheus endpoint, per-leg sample emission
  (verdict/endpoint/role labels, abort exclusion) in the DNS provider, and
  the boot-equivalent gate construction from the override env with the
  tertiary attached.
- CI: full quality gate (`npm run ci:backend`) plus the existing compose
  assertions extended to the tertiary env keys.
- Production: alert rule dry-run against the metrics endpoint after the
  override ships.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`.*