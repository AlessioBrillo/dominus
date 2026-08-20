# ADR-0065: DNS Privacy Mode and Tertiary Leg Redundancy

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-20 |
| **Authors** | Alessio Brillo |
| **Deciders** | Alessio Brillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0002, ADR-0039, ADR-0042, ADR-0045, ADR-0059, ADR-0063, ADR-0064 |
| **Project** | DOMINUS |

## Context

The DNS consensus gate (ADR-0039, ADR-0045) routes every candidate name
through up to three resolver opinions, all of which egress by default to
public resolvers: Cloudflare, Google and Quad9 over DoH/DoT (ADR-0042).
For a self-hosted operator that is a privacy contract with third parties —
every candidate name under evaluation (including closeout inventory not yet
acquired) is disclosed to those resolvers in plaintext DNS wire format.
ADRs 0039–0064 hardened the gate's independence, latency and resilience,
but none gave the operator a way to keep candidate names on-host. A privacy
mode was the obvious next axis: force every leg onto a pinned recursor so no
query leaves the host, and fail loudly if that pin is missing.

Separately, the tertiary redundancy decision in ADR-0064 wired a single
`doh-alternate` leg (Cisco OpenDNS) into the production override. That
restores the 2-of-3 gate when the co-hosted Unbound recursor dies, but it
leaves OpenDNS as a single point of failure for the tertiary leg itself:
if OpenDNS is unreachable or rate-limiting, the gate silently downgrades to
2-of-2 or 1-of-1. The operator-facing fix — adding a second operator to the
`doh-alternate` group — was impossible without a live-verified second
endpoint. Boot-time disjointness checks (ADR-0063) also degraded silently:
when a DoH hostname fails to resolve during startup, the strongest overlap
proof (resolved-IP comparison) was skipped with only a log line, and an
operator had no signal about how often the check ran blind.

This ADR records three related decisions: (1) `DNS_PRIVACY_MODE`, an opt-in
that forces every DNS leg to `native` against a pinned recursor and refuses
to boot without one; (2) a second live-verified `doh-alternate` leg (Digital
Society) so the tertiary survives the loss of either operator; and (3) an
`onResolutionPartial` observability hook that surfaces boot-time disjointness
checks which ran without full IP resolution.

## Decision Drivers

1. **Candidate names must be able to stay on-host** — a self-hosted
   deployment should be able to guarantee that no DNS query egresses to a
   third party. Without a pin, "privacy" via the system resolver would be
   fictional: the ISP's recursor sees every name.
2. **The tertiary leg must survive operator loss** — one `doh-alternate`
   leg is a single point of failure; two operators keep 2-of-3 availability
   when either is unreachable.
3. **Silent degradation must be observable** — disjointness checks that run
   without IP resolution are weaker proofs; operators need a counter and an
   alert, not just a log line.

## Considered Options

### Option A: Opt-in privacy mode that forces `native` and requires a pin

`DNS_PRIVACY_MODE` (default `false`) overrides every leg strategy —
primary, consensus secondary, tertiary — to `'native'`, and throws at boot
if `DNS_NAMESERVERS` is unset. The consensus gate survives only when the
secondary pins a *distinct* recursor via `DNS_CONSENSUS_NAMESERVERS`; the
endpoint disjointness check decides independence, and the native-vs-native
strategy veto is lifted because the strategy name no longer carries any
information in privacy mode.

**Advantages:**
- One env var, no new strategies, no new transports.
- Fail-loud boot: no silent leakage through the system resolver.
- Reuses the existing endpoint disjointness machinery to veto a
  same-recursor consensus (rubber stamp).

**Disadvantages:**
- Requires the operator to run (or know) a private recursor; consensus in
  privacy mode needs a second distinct recursor or the gate is vetoed.
- `DNS_DOH_ENDPOINT` and strategy values are ignored while enabled, which
  can surprise operators who set both.

**Cost Implications:** None — no new dependencies, no infra change.

**Risk Assessment:** Low. The gate veto for a single-recursor privacy-mode
install is the conservative outcome (ADR-0002); the boot error prevents a
worse failure mode (silent ISP visibility).

---

### Option B: Privacy mode as a strategy enum value

Add `'native-privacy'` to `DnsLookupStrategy` instead of a global flag.

**Advantages:**
- Per-leg control; a mixed topology is possible.

**Disadvantages:**
- Two names for the same mechanism complicate the disjointness checks
  (strategy-equality vetoes would need exemption tables), and a global flag
  is the honest model: privacy is a deployment property, not a leg property.

**Cost Implications:** Higher — touches every strategy branch and every
disjointness rule.

**Risk Assessment:** Medium — the equality-veto logic is exactly where
subtle gate-disabling bugs have lived before (ADR-0063).

---

### Option C: Second tertiary leg via a different DoH endpoint set

Extend `doh-alternate` to a two-leg group: OpenDNS + Digital Society
(`dns.digitale-gesellschaft.ch`, wire format), both live-verified through
the real `NodeDnsProvider` code path (OpenDNS 401 ms, Digital Society
366 ms registered; PowerDNS, dns.sb, dnswarden and tiar.app rejected as
timeout/502).

**Advantages:**
- Zero-config redundancy for the turnkey override: the tertiary survives
  either operator's outage.
- Both endpoints verified live over the actual code path before adoption.

**Disadvantages:**
- Both are European/US operators; a jurisdiction-restricted deployment may
  need its own `DNS_RESOLVER_GROUPS`.

**Cost Implications:** None — both endpoints are free public resolvers.

**Risk Assessment:** Low. Digital Society is run by a Swiss non-profit
(Digitale Gesellschaft), operator-disjoint from OpenDNS; the disjointness
check still guards every combination at boot.

---

### Option D: Observability via an `onResolutionPartial` hook

Thread an optional callback from the factory into
`validateConsensusDisjointness`; the resolver-validator invokes it when any
host fails to resolve and the IP-overlap proof degrades. The composition
root wires it to a new `recordDisjointnessResolutionPartial()` counter on
the metrics collector, exposed as
`dominus_dns_disjointness_resolution_partial_total` with a Prometheus alert
(`DnsDisjointnessResolutionPartial`) when the counter increases over
15 minutes.

**Advantages:**
- Fail-open: a throwing hook never fails the disjointness check.
- Alerting on a counter, not a log line: the operator knows when the gate
  has been running on weaker proofs.

**Disadvantages:**
- One more wiring seam between factory, validator and metrics.

**Cost Implications:** None.

**Risk Assessment:** Low — the hook is invoked inside an existing
try/catch around host resolution and wrapped in its own try/catch.

## Decision Outcome

**Chosen: Options A + C + D.** `DNS_PRIVACY_MODE` is a documented
opt-in (`false` default); the `doh-alternate` strategy now races two
operator-disjoint wire-format endpoints; the disjointness check surfaces
partial-resolution runs through the metrics collector.

## Consequences

**Positive:**
- Self-hosted operators can guarantee zero third-party DNS disclosure with
  one env var and a pinned recursor.
- The production override's tertiary leg survives the loss of OpenDNS or
  Digital Society.
- Boot-time disjointness degradation is visible in Prometheus with an alert.

**Negative:**
- Privacy mode with a single recursor disables the consensus gate (2-of-1 is
  not a gate); operators who want both must pin two distinct recursors.
- The `onResolutionPartial` counter is boot-time only: it counts startup
  checks, not per-query degradation (ADR-0064 histograms cover that).