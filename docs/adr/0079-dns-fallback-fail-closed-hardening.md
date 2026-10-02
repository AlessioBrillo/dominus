# ADR-0079: DNS Fallback Fail-Closed Hardening — Config Honesty, Provenance Truth, Bulk Index Safety

## Metadata

| Field          | Value                                  |
| -------------- | -------------------------------------- |
| **Status**     | Accepted                               |
| **Date**       | 2026-10-01                             |
| **Authors**    | AlessioBrillo                          |
| **Deciders**   | AlessioBrillo                          |
| **Supersedes** | N/A                                    |
| **Relates to** | ADR-0076, ADR-0078, ADR-0073, ADR-0002 |
| **Project**    | DOMINUS                                |

## Context

The DNS fallback path (ADR-0076) wraps `UnboundResolver` with a `FallbackResolver`
that delegates non-Available verdicts to `NodeDnsFallback` when the primary is
degraded. Three load-bearing defects were found during a resilience review:

1. **Silent DoH downgrade**: `createFallbackProvider('cloudflare-doh' | 'google-doh')`
   logged a warning and returned `NodeDnsFallback`. An operator selecting DoH
   redundancy unknowingly ran on the system resolver — a fail-open config lie.
2. **Provenance lie**: `UnboundResolver` stamped `dnssecSource: 'per-query'` for
   every Available verdict whenever per-query validation was enabled, even when
   the per-query call timed out, errored, or threw and the code fell back to the
   resolver-level stamp. Audit trail claimed cryptographic proof that never happened.
3. **Bulk duplicate collapse**: `FallbackResolver.checkBulk()` merged fallback
   results with `domains.findIndex((d) => d === domain)`. Duplicate domains in
   one bulk request collapsed onto the first index, overwriting results and
   dropping entries.

Per-query DNSSEC via `@relaycorp/dnssec` remains best-effort in production
(the default validate adapter throws and the resolver falls back to the
resolver-level negative-control proof). That behavior is retained; this ADR
only makes the provenance honest about which proof actually applied.

## Decision Drivers

1. **Fail-closed config (ADR-0002)** — Unimplemented options must throw, never silently downgrade.
2. **Provenance truth** — `dnssecSource` must reflect the proof actually used, not the proof configured.
3. **Bulk correctness** — Duplicate domains must resolve independently; index-based merge is the only safe strategy.
4. **Conservatism preserved** — No change to the Available-from-fallback safety gate; fallback still never serves Available.

## Considered Options

### Option A: Fail-closed + honest provenance + index merge (Chosen)

- `createFallbackProvider` throws for `cloudflare-doh` / `google-doh` with an actionable message.
- `UnboundResolver` tracks `perQueryValidated` and stamps `per-query` only on a real cryptographic verdict (`valid`, `bogus`, or `insecure` in permissive mode); timeout/error/throw stamps `resolver-level` or `unchecked`.
- `FallbackResolver.checkBulk` tracks `{ domain, index }` pairs end to end.
- Composition root forwards the fallback reason to logs/metrics instead of dropping it.

**Advantages:**

- Operator confusion eliminated; misconfiguration fails fast at startup.
- Audit trail trustworthy for post-incident forensics.
- Duplicate-heavy closeout CSVs no longer lose verdicts.
- Zero behavior change for the happy path; strictly safer failure modes.

**Disadvantages:**

- Operators with `DNS_FALLBACK_PROVIDER=cloudflare-doh` in `.env` will fail at boot until they set `node-dns` (intended breaking fail-closed change).

### Option B: Implement DoH fallback providers now

Rejected: DoH legs were deprecated by ADR-0075 (Unbound single source of truth).
Reintroducing them as fallback re-adds operator-diversity complexity without
DNSSEC validation, and does not fix the provenance or bulk bugs.

### Option C: Full production @relaycorp/dnssec wire adapter

Rejected for this step: requires raw DNS wire construction (DO bit, TCP
fallback, `Message.deserialise`) and a dedicated test harness against live
signed/unsigned/bogus zones. Valuable long-term, but high risk as a single
change alongside the three fail-closed fixes. Tracked as follow-up work.

## Decision

Implement Option A.

## Consequences

Positive:

- Fail-closed startup for unimplemented fallback providers.
- Honest `dnssecSource` in `DnsCheckResult` and `VerdictProvenance`.
- Correct bulk merge for duplicate domains.
- Fallback activation reason preserved in logs and `dominus_dns_fallback_active` context.

Negative:

- Intentional breaking change for `DNS_FALLBACK_PROVIDER=cloudflare-doh|google-doh` (must migrate to `node-dns`).

## Implementation

- `src/providers/dns/fallback-resolver.ts` — throw on unimplemented DoH; index-based bulk merge.
- `src/providers/dns/unbound-resolver.ts` — `perQueryValidated` provenance gate.
- `src/config.ts`, `.env.example` — document DoH as reserved/fail-closed.
- `src/app/composition-root.ts` — forward fallback reason.
- Tests: DoH fail-closed, duplicate bulk, per-query timeout vs valid provenance.
- Docs: `README.md` pipeline description corrected (Unbound, not Node dns module).
