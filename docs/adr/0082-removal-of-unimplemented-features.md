# ADR-0082: Remove features that were declared but never worked

## Metadata

| Field          | Value                                            |
| -------------- | ------------------------------------------------ |
| **Status**     | Accepted                                         |
| **Date**       | 2026-10-08                                       |
| **Authors**    | Alessio Brillo                                   |
| **Deciders**   | Alessio Brillo                                   |
| **Supersedes** | ADR-0073, ADR-0070, ADR-0071                     |
| **Relates to** | ADR-0002, ADR-0004, ADR-0072, ADR-0075, ADR-0079 |
| **Project**    | DOMINUS                                          |

## Context

The v1.1.0 audit found code paths that were configured, documented and ticked
off in the roadmap but that could not do what they claimed:

- **Per-query DNSSEC validation (ADR-0073)** was enabled by default. Its default
  validator always threw, so every Available verdict logged a warning and fell
  back to the resolver-level proof. The env var was also spelled differently in
  code (`DNS_PER_QUERY_DNSEC`) and in the ADR (`DNS_PER_QUERY_DNSSEC`).
- **DoH fallback providers (`cloudflare-doh`, `google-doh`)** were accepted by the
  config schema and threw "not implemented" at startup.
- **Sedo, Afternic and Dan.com listing adapters (ADR-0070/0071)** called REST
  endpoints (`api.sedo.com/v1`, ...) that had never been checked against the
  vendors' real APIs; Afternic and Dan were near-copies of each other.
- **Registrar credentials** for GoDaddy, Namecheap, Porkbun, NameSilo and
  Dynadot were documented in `.env.example`; no code read them.
- **Kubernetes manifests** were pinned to v0.10.1, SQLite-only and ran no worker
  or scheduler, so jobs and backups would never run there.
- **The consensus compose overlay** and the Terraform cloud-init referenced the
  `DNS_CONSENSUS_*` variables removed by ADR-0072.

ADR-0002 (conservatism) and the project principle "cost is a functional
requirement" argue against shipping controls that look like safeguards but are
inert: they create false assurance and operator confusion.

## Decision Drivers

1. Do not claim assurance the code cannot deliver (DNSSEC proof, marketplace sync).
2. Smaller surface area to secure, test and document for a first official release.
3. Re-adding a provider later is one adapter behind an interface (ADR-0004).

## Considered Options

### Option A: Implement each feature properly now

Full DS -> DNSKEY -> RRSIG validation, DoH clients, three marketplace clients.

**Advantages:** feature-complete on paper.

**Disadvantages:** marketplace APIs need partner accounts we do not have, so
they cannot be verified; hand-rolled DNSSEC validation is high-risk code.

**Cost Implications:** weeks, plus recurring vendor access. **Risk Assessment:** high.

---

### Option B: Keep the code, default it off, label it experimental

**Advantages:** no deletion.

**Disadvantages:** unverified code stays in the release; config surface and docs
keep advertising it.

**Cost Implications:** low now, carried forever. **Risk Assessment:** medium.

---

### Option C: Remove them (chosen)

**Advantages:** the release contains only behaviour that is tested; Unbound with
strict DNSSEC remains the single source of truth (ADR-0072/0075).

**Disadvantages:** operators who set the removed variables see them ignored
(removed keys are listed in the upgrade notes).

**Cost Implications:** negative (less to maintain). **Risk Assessment:** low.

## Decision Outcome

Chosen option: **C**. Removed: per-query DNSSEC and its config; DoH fallback
types (`DNS_FALLBACK_PROVIDER` accepts only `node-dns`); Dan/Afternic/Sedo
adapters (`LISTING_PROVIDER` accepts only `manual`; the listing `marketplace`
field remains a free label); the unused registrar credential documentation;
`docker-compose.dns-consensus.yml`; the Kubernetes manifests (supported targets
are Docker Compose and the Terraform/Hetzner stack); the `@relaycorp/dnssec`
dependency; and dead modules.

### Consequences

- ADR-0073, ADR-0070 and ADR-0071 are marked Superseded by this ADR.
- The Terraform cloud-init now sets `DNS_UNBOUND_ENABLED`/`DNS_UNBOUND_HOSTS`
  for the co-hosted recursor instead of the removed `DNS_CONSENSUS_*` variables.
- Re-introducing any of these requires a new ADR with evidence it works against
  the real service.
