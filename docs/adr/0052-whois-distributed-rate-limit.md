# ADR-0052: WHOIS Distributed Rate-Limit Parity

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-10 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0002, ADR-0035, ADR-0039, ADR-0041, ADR-0044, ADR-0049, ADR-0050, ADR-0051 |
| **Project** | DOMINUS |

## Context

Every network-facing provider budget in DOMINUS runs on a distributed Redis
namespace when the deployment is cloud topology: `rdap`, `uspto`, `euipo`,
`wayback`, `dns`, `dns-consensus` (ADR-0044) and `rdap-consensus` (ADR-0050).
WHOIS is the sole exception — `buildWhoisProviders` always constructs
per-process in-memory token buckets (`provider-factory.ts`), even when a
Redis client is connected.

Three consequences follow:

1. **Multi-process multiplication.** With N replicas, the registry-facing
   WHOIS query rate is N× the configured budget. WHOIS is the most
   restrictive channel in the stack (default 2 tokens / 2000 ms), and
   registry-side port-43 throttling or IP blocking degrades the whole
   pipeline — including, from ADR-0051, the RDAP consensus rescue leg that
   now deliberately routes re-checks through this very channel.
2. **No per-tenant isolation (ADR-0041 gap).** All other providers gained
   per-tenant fair share on top of their shared bucket; WHOIS has no
   `WHOIS_RATE_LIMIT_PER_TENANT_*` knobs, so in multi-tenancy one tenant's
   run could starve every other tenant on the shared WHOIS budget.
3. **Fail-open drift after Redis outages.** The in-memory fallback already
   exists inside `RedisRateLimiter` for other providers; WHOIS never even
   attempted the distributed path.

The single-user community edition (SQLite, one process) is unaffected in
behaviour: without Redis the exact same in-memory token buckets are built.

## Decision

Close the parity gap with the established ADR-0041/ADR-0044 pattern:

1. **New `whois` Redis namespace.** `buildWhoisRateLimiter(config, redis)`
   returns a `RedisRateLimiter` (namespace `whois`) when Redis is connected
   and the existing in-memory `RateLimiter` otherwise. It honours the
   existing `WHOIS_RATE_LIMIT_TOKENS`/`_INTERVAL_MS` tuning.
2. **Per-tenant fair share knobs.** New `WHOIS_RATE_LIMIT_PER_TENANT_TOKENS`
   (default 1) and `WHOIS_RATE_LIMIT_PER_TENANT_INTERVAL_MS` (default 2000).
   Defaults sit below the shared bucket (2 tokens / 2000 ms) so the tenant
   window is an actual isolation bound, mirroring the RDAP pattern (3 vs 10)
   and the DNS consensus pattern (5 vs 20). Enforced only when Redis is the
   rate limiter and `PROVIDER_FAIR_SHARE_ENABLED` is on (ADR-0041).
3. **Per-TLD overrides become per-TLD namespaces.** `WHOIS_RATE_LIMIT_OVERRIDES`
   keeps its exact parsing and fallback semantics, but in cloud mode each
   override maps to its own `whois:<tld>` Redis bucket with fair share
   enabled — a tenant cannot drain the strictest registry buckets on behalf
   of all. Invalid JSON silently degrades to no overrides, unchanged.
4. **Wider provider types.** `NodeWhoisProviderConfig` accepts
   `RateLimiterLike` for `defaultRateLimiter`/`perTldRateLimiters` so both
   implementations can be injected; the provider only ever calls `throttle()`.
5. **`buildRateLimiters` exposes `whois`.** `BuiltRateLimiters` grows the
   `whois` entry in both branches, and `composition-root` passes the Redis
   client into `buildWhoisProviders`.

### Options considered and rejected

- **Status quo (in-memory only).** Acceptable for single-process community,
  broken for Cloud: N× registry traffic and no tenant isolation. Rejected as
  the end state; preserved as the no-Redis fallback.
- **Plain Redis namespace without fair share.** Matches `uspto`/`euipo`/
  `wayback`, but WHOIS is exactly the shared-budget starvation scenario
  ADR-0041 was written for (2 tokens / 2000 ms shared, many tenants).
  Rejected: half the fix.
- **Per-TLD fair-share knobs.** Adding `WHOIS_RATE_LIMIT_PER_TENANT_*`
  variants per TLD would double the config surface for rarely-used overrides;
  the per-TLD buckets default their tenant window to their own tokens
  (`RedisRateLimiter` default), which is already an isolation bound.
  Rejected: unnecessary surface.

## Consequences

### Positive

- N replicas enforce one registry-facing WHOIS rate; a tenant's burst is
  capped independently of others (Cloud).
- The RDAP consensus WHOIS rescue leg (ADR-0051) inherits the distributed
  budget automatically — it reads from the same provider.
- Community behaviour is byte-for-byte unchanged (in-memory path preserved).
- Operators can inspect the `whois` and `whois:<tld>` buckets in Redis and
  the per-tenant windows alongside the other namespaces.

### Negative

- Two more required config fields in the `Config` type; all fixtures and the
  example env document them.
- In-memory fallback remains per-process (fail-open relative to the Redis
  budget during an outage) — the same accepted trade-off as every other
  provider namespace.
- `WHOIS_RATE_LIMIT_OVERRIDES` now has different storage semantics per mode
  (in-memory buckets vs `whois:<tld>` namespaces); behaviour from the
  caller's perspective is identical.

### Risks and mitigation

- **Operator confusion from duplicated per-TLD parsing.** The parsing logic
  is duplicated between `buildPerTldWhoisRateLimiters` (providers/whois) and
  `buildWhoisPerTldRateLimiters` (provider-factory). Mitigated by mirroring
  semantics exactly and pinning both with tests; a future consolidation into
  one shared parser is noted as follow-up.
- **Per-tenant defaults too strict for bursty single-tenant runs.** 1 token
  per 2000 ms per tenant is conservative by design ("registered wins" and
  WHOIS is the weakest channel); operators on Cloud can raise the knob per
  their registry behaviour.

### Related ADRs

- ADR-0002 (conservatism — WHOIS is the weakest channel; stay below its cap)
- ADR-0035 (WHOIS bounded enrichment inside RDAP confirmation)
- ADR-0039 / ADR-0051 (WHOIS rescue leg rides the same rate limiter)
- ADR-0041 (per-tenant fair share — the pattern extended here)
- ADR-0044 / ADR-0050 (dedicated provider budgets — the parity target)