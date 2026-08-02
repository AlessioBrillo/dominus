# ADR-0035: RDAP Authoritative Bootstrap Resolution

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-02 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0001, ADR-0003, ADR-0004 |
| **Project** | DOMINUS |

## Context

RDAP availability checks are a correctness-critical pipeline stage: a false
"Available" leads to a wasted buy recommendation, and a false "Registered"
drops a legitimate candidate. The current `FailoverRdapProvider` ships a
hardcoded default server list with two defects:

1. **Wrong endpoint**: the Verisign entry (`https://rdap.verisign.com/com/domain/`)
   omits the required `/v1/` path segment and returns 404 for every COM
   query. Worse, the 404 is interpreted as `Available` — a systematic false
   positive for the most valuable TLD in the dataset.

2. **Out-of-zone responses treated as authoritative**: a 404 from any
   server (e.g. the COM registry asked about a `.io` name) is interpreted
   as `Available`. RFC 7484 defines that only the authoritative registry
   for a domain's TLD can answer "not registered". All other responses are
   meaningless for availability.

The Google Registry RDAP entry is also unreachable in practice, leaving
rdap.org as the only working default.

## Decision

Resolve the authoritative RDAP server per TLD from the IANA RDAP bootstrap
registry (`https://data.iana.org/rdap/dns.json`, RFC 7484 §3), and make
availability semantics TLD-scoped:

1. **New `IanaRdapBootstrap`** (`src/providers/rdap/rdap-bootstrap.ts`):
   fetches the IANA registry JSON (10s timeout, 24h in-memory TTL, single
   in-flight request), maps TLD → authoritative base URLs, and always
   appends rdap.org as a routing fallback. A failed or absent bootstrap
   degrades to rdap.org-only routing — never to incorrect 404 semantics.

2. **`FailoverRdapProvider` rework** (`src/providers/rdap/failover-rdap-provider.ts`):
   - per-TLD candidate list: fixed providers (rdap.org universal) plus the
     bootstrap-resolved authoritative servers, cached per TLD;
   - race semantics: only a *definitive* answer (Available/Registered) wins;
     an `Unknown` response (out-of-zone 404, rate-limit wait, server error)
     never wins the race — the remaining servers keep resolving, and the
     first Unknown is returned only if every server yields Unknown;
   - `withDefaults()` replaces the hardcoded default list (removing the
     broken Verisign/Google entries); `fromConfig()` keeps custom URLs as
     universal servers for operator override;
   - rate limiting is applied per request via the shared limiter, so the
     configured `RDAP_RATE_LIMIT_*` budget covers the sum of all servers.

3. **TLD-scoped 404 semantics in `PublicRdapProvider`**: a 404 is
   `Available` only when the provider is scoped to the domain's TLD
   (constructor `tlds` parameter). Otherwise it returns `Unknown`.

4. **Configuration**: new `RDAP_BOOTSTRAP_URL` env (default IANA URL, empty
   string disables per-TLD resolution). `RDAP_BOOTSTRAP_URLS` (JSON array)
   remains as an explicit operator override that bypasses bootstrap
   resolution entirely.

## Consequences

### Positive

- False "Available" responses from wrong-server 404s are eliminated; a 404
  from the authoritative registry (correctly resolved) still means
  "not registered".
- The broken hardcoded Verisign and unreachable Google defaults are gone;
  the default path is IANA-resolved authoritative servers plus rdap.org.
- Degradation is conservative: bootstrap failure, unknown TLDs, and
  all-server failure all resolve to Unknown/error — never a fabricated
  Available.
- Circuit breakers remain per-server, isolating degraded authoritative
  registries.

### Negative

- One extra dependency on `data.iana.org` at first RDAP use (10s worst-case
  latency if unreachable, cached for 24h thereafter).
- Custom `RDAP_BOOTSTRAP_URLS` operators are now responsible for TLD scope;
  their URLs are treated as universal.
- Slightly more complex failover logic than the original sequential list
  (per-TLD resolution, definitive-winner race).

### Risks and mitigation

- **Bootstrap abuse/misconfiguration**: `RDAP_BOOTSTRAP_URL` accepts only
  http(s) URLs; a hostile registry server can only ever cause `Registered`
  or `Unknown` responses (and per-request rate limiting applies).
- **Stale bootstrap data**: 24h TTL is short enough to track registry
  changes while avoiding per-call fetches.
