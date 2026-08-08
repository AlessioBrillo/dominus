# ADR-0042: Private Recursor for the DNS Consensus Secondary

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-07 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0004, ADR-0039, ADR-0040 |
| **Project** | DOMINUS |

## Context

The 2-of-3 DNS consensus gate (ADR-0039, ADR-0040) requires the secondary
provider to use a resolver strategy disjoint from the primary
(`DNS_CONSENSUS_STRATEGY`, default `dot-only`). On the Cloud topology
(ADR-0026, ADR-0027) the app runs on a single VM, and `dot-only` relies on
egress TCP/853 to public DoT resolvers discovered via DHCP.

That egress is **not guaranteed** on a single-VM deployment (C3 of the
cloud hardening review): the hosting provider may filter outbound TCP/853,
or the DHCP-supplied resolver list may be empty/unusable. When that
happens, every consensus secondary query fails, every Available verdict is
downgraded to Unknown, and the whole consensus gate degrades (ADR-0039)
even though the primary DoH/DoT path works fine. The secondary is the
consensus *chokepoint*: its strategy must be viable in the environment
where the app actually runs.

Public DoT via the same endpoints as the primary was rejected because the
consensus gate exists precisely to avoid sharing resolver endpoints
(ADR-0039 disjointness check).

## Decision

**Pin the consensus secondary to a private, co-hosted recursive resolver
(Unbound) via an optional `DNS_CONSENSUS_NAMESERVERS` setting.**

- `DNS_CONSENSUS_NAMESERVERS` (comma-separated `host` or `host:port`
  addresses) is an optional setting. When set, the secondary provider is
  built with `lookupStrategy: 'native'` and `nameservers` pointing at those
  addresses — overriding `DNS_CONSENSUS_STRATEGY` verbatim.
- When unset, behaviour is unchanged: `DNS_CONSENSUS_STRATEGY` is used as
  before (backward compatible).
- The recursor is an optional compose override
  (`docker-compose.dns-consensus.yml`): a `mvance/unbound` service (the
  community-maintained image recommended by the Unbound project — NLnet Labs
  publishes no official image, and the original `nlnetlabs/unbound` reference
  did not exist on Docker Hub) on a dedicated `/24` subnet (`172.20.0.0/24`),
  pinned to the deterministic address `172.20.0.10:5300`, with `api`,
  `worker`, and `scheduler` joining that network. The image is digest-pinned
  and amd64-only (ADR-0046). The base and prod compose files are untouched;
  the override is opt-in via `-f docker-compose.dns-consensus.yml`.
- Node's `resolver.setServers()` only accepts IP literals, not service
  hostnames — hence the fixed IPAM address instead of a service name.
- Unbound config (`deploy/unbound/unbound.conf`): recursive resolution from
  the root (no forwarding), qname-minimisation, DNSSEC validation enabled,
  ACL restricted to loopback + the compose `/24`, localhost remote-control
  for the healthcheck.

### Options considered and rejected

- **Keep `dot-only` and add retries/fallback** — rejected: the failure is
  environmental (egress TCP/853 filtered or no DHCP resolver), not
  transient; retries cannot fix a blocked port.
- **Use the primary's DoH endpoints for the secondary** — rejected:
  violates the endpoint-disjointness check that is the entire point of the
  gate (ADR-0039).
- **Run the recursor inside the base prod compose** — rejected: forces the
  recursor on every deployment; it is only needed when public DoT egress is
  unavailable. An opt-in override keeps the base topology stable (CI
  topology check unchanged).
- **Forward to a fixed public recursor (1.1.1.1, 8.8.8.8) via plain UDP** —
  rejected: the second opinion must not come from the same resolvers the
  primary can reach via DoH; a co-hosted recursor keeps the opinions
  genuinely disjoint.

## Consequences

### Positive

- The consensus gate keeps its independent second opinion even when the VM
  cannot reach public DoT resolvers; egress TCP/853 is no longer a
  deployment requirement.
- Fully backward compatible: unset `DNS_CONSENSUS_NAMESERVERS` preserves
  the ADR-0039/0040 behaviour and all existing tests.
- The compose override is opt-in and does not perturb the validated base
  topology or the CI compose checks.

### Negative

- The recursor is another co-hosted service with its own CPU/memory budget
  (bounded via `deploy.resources`).
- A compromised recursor could influence the secondary opinion; mitigated
  by the loopback/subnet ACL and by DNSSEC validation in Unbound.

### Risks and mitigation

- **Misconfiguration** (pin reusing the primary resolvers, e.g.
  `DNS_CONSENSUS_NAMESERVERS=1.1.1.1` while the primary DoH uses 1.1.1.1) —
  the existing endpoint-disjointness check treats reused endpoints as an
  invalid setup and refuses to enable consensus, same as ADR-0039.
- **Unbound not reachable** (override not deployed) — the native secondary
  fails like any other secondary failure and the ADR-0039 degradation
  policy applies; the operator sees the provider status note pointing at
  the configured recursor.
