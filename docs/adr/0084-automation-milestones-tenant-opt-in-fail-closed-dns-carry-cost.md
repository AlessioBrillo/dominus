# ADR-0084: Automation milestones — tenant opt-in, fail-closed DNS writes, carry-cost verdicts

## Metadata

| Field          | Value                                                       |
| -------------- | ----------------------------------------------------------- |
| **Status**     | Accepted                                                    |
| **Date**       | 2026-10-15                                                  |
| **Authors**    | Alessio Brillo                                              |
| **Deciders**   | Alessio Brillo                                              |
| **Supersedes** | —                                                           |
| **Relates to** | ADR-0002, ADR-0004, ADR-0006, ADR-0023, ADR-0038, ADR-0082, ADR-0083 |
| **Project**    | DOMINUS                                                     |

## Context

ADR-0083 established the journaled post-acquisition pipeline
(`portfolio → site → indexing → dns → parking → listing`) behind the
`AUTOMATION_ENABLED` kill switch and the `AUTOMATION_DRY_RUN` default, and
its amendment fixed the shape of the fail-closed DNS write gate before any
provider existed. This ADR records the decisions taken while implementing
the remaining milestones (Phase 0, M3, the honest part of M4, M5) and the
boundaries that were deliberately not crossed.

The product goal is a fully automated lifecycle after a purchase — site,
indexing, DNS delegation, ads monetization, marketplace listing, exit — so
a SaaS tenant can buy a domain and let it become self-sustaining. Three
constructions in that path spend real money or mutate externally visible
state, and two external dependencies (parking and marketplace APIs) cannot
be verified without vendor access.

## Decision Drivers

1. A SaaS tenant must own its own switch, without weakening the operator's
   global brake (ADR-0002 conservatism, ADR-0038 tenant isolation).
2. The DNS step is the first step that mutates state a visitor's traffic
   depends on; the amendment's fail-closed model must survive contact
   with implementation.
3. The community edition must keep working with zero paid API
   dependencies; vendor adapters may only land verified (ADR-0082).
4. The carry-cost verdict must never drop a domain on its own: it feeds
   the drop engine as a Reprice signal, keeping the human gate.

## Decision

1. **Tenant opt-in (Phase 0).** A `tenant_automation_settings` table
   (one row per tenant, default: opted out, dry-run) holds the tenant's
   own switch. The effective gate is the conservative combination:
   `enabled = env AND tenant`, `dryRun = env OR tenant`. The operator
   brake can only ever tighten a tenant's wish, never loosen it. The
   Automation dashboard page exposes settings, step journal and audit
   trail; `dominus automate settings --enabled/--dry-run` does the same
   from the CLI.

2. **Fail-closed DNS writes (M3).** The `dns` step writes only after an
   independently corroborated conclusion about the current state: the
   write provider's view of the zone plus a public-DNS read of the
   delegation, and the write is confirmed publicly afterwards. Anything
   else is a named skip (with the manual instructions recorded in the
   journal) or a named, resumable failure (`write_unconfirmed`) — never a
   best-effort "probably applied". `ManualDnsWriteProvider` is the honest
   default; `CloudflareDnsWriteProvider` is the first automated adapter.

3. **Revenue ingestion is a read (M3).** `MonetizationProvider` exposes
   one method; the first implementation is a CSV reader over an operator
   export (zero paid API dependencies, same pattern as the comps/keyword
   providers). Writes are idempotent at (domain, date, source), so a
   repeated ingestion corrects figures instead of double-counting them.
   No provider → the step skips with `monetization_provider_unavailable`.

4. **Tenant listing policy (M4, partial).** What works today without
   verified vendor APIs: a fixed base price for automatic listings
   (`tenant_listing_settings.pricePolicy`) and offer rules (auto-decline
   below a floor, counter below a counter price; both off by default,
   the decline floor always checked first). The Afternic/Dan/Sedo
   ListingProvider adapters stay out until their APIs are verified
   (ADR-0082); the manual provider keeps tracking listings locally.

5. **Carry-cost verdicts (M5).** A scheduler job (`REVENUE_SYNC`,
   read-only) ingests revenue on a cron; `computeCarryCostVerdict`
   annualises revenue over the observed window (never extrapolating from
   less than 30 days) against the renewal cost and reports
   `sustainable | marginal | loss | insufficient_data`. A `loss` refines a
   `Keep` from the drop engine into `Reprice` — visible in the portfolio
   and at `GET /api/v1/sustainability` — and never drops a domain by
   itself.

## Considered Options

### Option A: Tenant opt-in as a single global switch (env only)

**Advantages:** nothing new to build.

**Disadvantages:** in a multi-tenant SaaS every tenant would inherit one
operator's choice, and the tenant could not turn automation off without
an operator. Rejected.

### Option B: Write-then-compensate DNS writes (retry/rollback on failure)

**Advantages:** familiar transactional shape.

**Disadvantages:** compensation assumes the compensating action succeeds —
precisely what is uncertain during the incident that produced the bad
read (ADR-0083 amendment). Rejected.

### Option C: Invent the Sedo/Afternic API contracts now

**Advantages:** the roadmap lines could be ticked.

**Disadvantages:** exactly the ADR-0082 failure mode — adapters that were
never exercised against the vendor, deleted one release later. Rejected;
they return with verified access.

## Consequences

**Positive:** the lifecycle is automated as far as honestly possible; the
dangerous steps (DNS, money) are gated twice (kill switch + dry-run) and
audited; the tenant sees and controls its own switch; every unverified
dependency degrades to a named skip instead of a silent failure.

**Negative:** new tables (0063–0065) and a new job type; operators must
understand that both switches must allow a run; the vendor adapters remain
a blocked line until API access exists.

**Compliance Check:**

- [x] ADR-0002 conservatism: no step acts on uncertain state; unset
      configuration always skips.
- [x] ADR-0004 provider abstraction: every external dependency is behind
      an interface (DnsWriteProvider, MonetizationProvider,
      PublicDelegationReader).
- [x] ADR-0006 trademark gate: untouched, still the publish gate for
      listings and offers.
- [x] ADR-0023 async execution: REVENUE_SYNC runs on the existing queue
      with handler registration asserted by the parity test.
- [x] ADR-0038 tenant isolation: every new table is repository-scoped.
- [x] ADR-0082 honesty: nothing is declared before it works; unverified
      adapters stay out.
- [x] English identifiers, comments and documentation throughout.
