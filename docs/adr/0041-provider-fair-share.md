# ADR-0041: Distributed Per-Tenant Provider Fair Share

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-07 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0004, ADR-0023, ADR-0038 |
| **Project** | DOMINUS |

## Context

On the Cloud topology (ADR-0026, ADR-0027) every API replica, worker, and
scheduler shares one Redis instance, and `buildRateLimiters()` creates one
Redis sliding-window bucket **per provider** (`ratelimit:dns`,
`ratelimit:rdap`, ...). The tenant context exists only inside the job
handler (`runWithTenant`), so the rate limiter has no notion of who is
consuming the budget.

The result is a **shared-tragedy fairness gap**: a single tenant submitting
large pipeline runs (the 10k-candidate scenario) can saturate the shared
DNS or RDAP bucket and starve every other tenant of the platform. The
community edition is single-user and unaffected; the problem only exists
when the Redis limiter is active, i.e. DOMINUS Cloud.

Per-tenant isolation of the whole provider budget (one full bucket per
tenant) was rejected because the budget is a hard constraint of the
upstream public resolvers / registries (C7 of the cloud hardening review):
giving every tenant a full copy multiplies the real-world request rate by
the tenant count and would break the actual upstream limits we are
protecting.

## Decision

**Fair share, not isolation: keep the shared platform bucket, and add an
independent per-tenant sliding window on top of it.**

- `RedisRateLimiter` gains an optional `fairShare` + `perTenantTokens` /
  `perTenantIntervalMs` configuration (default: off, preserving the
  community behaviour bit-for-bit).
- When enabled, `acquire()` resolves the tenant from AsyncLocalStorage
  (`getTenantId()`) and enforces a *second* sliding window keyed
  `ratelimit:{namespace}:tenant:{tenant}`. A token is granted only when
  **both** the shared bucket and the tenant's own window have capacity.
- The tenant window TTL equals `perTenantIntervalMs`, so it cannot
  accumulate garbage keys; the `default` tenant and callers without tenant
  context skip the per-tenant check (single-user community path unchanged).
- `PROVIDER_FAIR_SHARE_ENABLED` (default `true`) is the global kill-switch,
  and `DNS_RATE_LIMIT_PER_TENANT_TOKENS` (default 5/s) /
  `RDAP_RATE_LIMIT_PER_TENANT_TOKENS` (default 3/s) size the per-tenant
  windows. Defaults cap one tenant at a quarter (DNS) / a third (RDAP) of
  the shared budget.
- The tenant window is enforced inside the Redis limiter only. The local
  in-memory `RateLimiter` path is single-process and single-user; it stays
  untouched (ADR-0023 worker model already limits it to one process).

### Options considered and rejected

- **One full bucket per tenant (isolation)** — rejected: multiplies the
  upstream request rate by tenant count; the upstream resolver/registry
  limits are what the shared bucket protects (C7 review finding).
- **Fair share at the HTTP/proxy layer** — rejected: the pipeline is
  async-first (ADR-0023) and provider calls happen inside job handlers, not
  per-request; only the limiter chokepoint sees every provider call.
- **Tenant-aware weighting in a single bucket** — rejected: sliding-window
  zset members carry no tenant tag and a fair-queuing rewrite of the Redis
  structure would break backwards compatibility with the local limiter
  contract for zero user-visible gain.

## Consequences

### Positive

- One tenant can no longer starve the platform: a saturated tenant fails
  fast (`RateLimiterWaitTimeoutError`) instead of hoarding the shared
  budget; other tenants keep their slice.
- Community edition unchanged: `fairShare` defaults off, the `default`
  tenant and no-context callers never touch tenant keys.
- Ops can tune fairness per provider without touching shared budgets, and
  the kill-switch allows instant rollback to the pre-ADR behaviour.

### Negative

- Two Redis keys per acquire on the fair-share path (shared + tenant
  window), i.e. one extra pipelined read/write pair per token; negligible
  vs. the provider round-trips the limiter gates.
- A heavy tenant's run may now see `RateLimiterWaitTimeoutError` where it
  previously saw a saturated-but-usable shared bucket; the error is
  bounded (`maxWaitMs`) and already part of the pipeline's degradation
  vocabulary.

### Risks and mitigation

- **Misconfiguration** (`perTenantTokens` above the shared budget) — the
  tenant window would become the binding constraint and effectively
  enforce a lower global rate; the env docs require
  `per-tenant tokens <= shared tokens`.
- **Tenant key growth on churn** — bounded by `pexpire` with the tenant
  window interval; keys self-expire when a tenant goes idle.
