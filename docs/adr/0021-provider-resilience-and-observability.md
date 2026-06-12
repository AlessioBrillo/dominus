# ADR-0021: Provider Resilience and Observability Layer

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-06-12 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0004, ADR-0014 |
| **Project** | DOMINUS |

## Context

DOMINUS relies entirely on free and public APIs for all data sources: rdap.org
for RDAP lookups, tmsearch.uspto.gov for trademark searches, whois.iana.org
for WHOIS server discovery, and EUIPO's free-tier Trademark Search API. These
services have no SLA, no guaranteed uptime, and no formal deprecation policy.

In v0.1-v0.2, each provider was a single-point-of-failure:
- `PublicRdapProvider` used only `rdap.org/domain/`. When rdap.org experienced
  downtime (observed multiple times), the entire RDAP confirmation stage
  produced zero results — the operator saw "no available candidates" with no
  indication that the cause was a provider outage.
- Pipeline stage errors were logged but not surfaced in the CLI output or
  persisted for later analysis.
- The circuit breaker was in-memory only, so provider degradation was forgotten
  on process restart.
- Health checks ran on demand but produced no historical record.
- The Express server's `SIGTERM` handler did not drain active connections,
  risking truncated database writes during rolling updates.

This ADR documents the introduction of a provider resilience and observability
layer that addresses these gaps without violating the zero-cost API constraint.

## Decision Drivers

1. **Resilience over correctness** — A degraded provider must not silently
   produce empty results. The system must fall back to alternative sources
   and surface the degradation to the operator.
2. **Zero-cost constraint** — All fallback providers must also be free/public.
   No paid API subscriptions are permitted.
3. **Observability as a first-class feature** — Provider health, circuit
   breaker state, and pipeline stage errors must be visible to the operator
   through CLI, API, and persisted history.
4. **Backward compatibility** — Existing deployments must continue working
   without configuration changes. New features must opt-in or default to
   the existing behaviour.

## Considered Options

### Option A: Multi-provider failover with health history (chosen)

Introduce a `FailoverRdapProvider` that queries N bootstrap servers in
sequence (default: rdap.org → Verisign COM RDAP → Google Registry RDAP).
The first successful response wins; all failures trigger a configurable
delay before the next attempt. Provider health outcomes are persisted in
a `provider_health` table for historical analysis.

**Advantages:**
- Eliminates single-point-of-failure for the most critical pipeline stage
- Health history enables trend analysis of provider reliability
- Sequential failover is predictable and debuggable
- Circuit breaker state survives process restarts
- No API cost increase — all bootstrap servers are free/public

**Disadvantages:**
- Sequential failover adds latency (500ms delay between attempts)
- More outbound connections from the Docker container
- Requires new database migration and repository code

**Cost Implications:** ~2 engineering days. Zero operational cost. Zero API cost.

**Risk Assessment:** Low risk. Fallback providers are well-known RDAP
bootstrap servers operated by registry operators (Verisign, Google).
If all three are down, RDAP is genuinely unavailable.

---

### Option B: Concurrent multi-provider query (first-past-the-post)

Query all N RDAP servers in parallel. The first successful response wins;
all other in-flight requests are discarded. This is the lowest-latency
approach.

**Advantages:**
- Lowest latency (response time of the fastest server, not the slowest)
- Maximum resilience against individual server outages
- Ideal for watchlist polling where latency matters

**Disadvantages:**
- 3x outbound bandwidth per request (wasteful when all servers are healthy)
- Harder to debug which server actually responded
- More concurrent connections may trigger rate limits on healthy servers
- False positives from a server returning incorrect data (no validation)

**Cost Implications:** ~1.5 engineering days. Higher bandwidth usage. Zero API cost.

**Risk Assessment:** Medium. Parallel queries from a single IP may trigger
rate limiting on all servers simultaneously.

---

### Option C: Single provider with enhanced error reporting (status quo +)

Keep the single-provider architecture but add comprehensive error reporting:
each stage failure is logged with provider name, error type, and candidate
context. No automatic failover.

**Advantages:**
- Minimal code changes (only error reporting infrastructure)
- Predictable behaviour — always the same provider, same response format
- No additional outbound connections
- Full backward compatibility

**Disadvantages:**
- No automatic recovery when a provider is down
- Operator must manually intervene (switch config, restart with different URL)
- Pipeline run produces zero results during provider outage
- Error reporting helps debugging but doesn't prevent lost pipeline runs

**Cost Implications:** ~0.5 engineering days. Zero operational cost.

**Risk Assessment:** High. Operator may not notice errors until after
a pipeline run completes with zero recommendations.

## Decision

**Chosen option: Option A — Multi-provider failover with health history**

Option A was chosen because it addresses the root cause (provider
unavailability) rather than just the symptom (silent errors). The
sequential failover approach is predictable, debuggable, and respects
rate limits on all servers.

Rejected alternatives:
- Option B (concurrent) was rejected because it wastes bandwidth when
  all servers are healthy and may trigger rate limits from aggressive
  parallel requests. The latency benefit over sequential failover
  (500ms delay) is negligible for batch pipeline runs.
- Option C (status quo +) was rejected because it fails the first
  decision driver — resilience. Error reporting without automatic
  recovery still produces empty results during provider outages.

## Consequences

### Positive
- RDAP stage resilience against bootstrap server downtime (3 servers
  instead of 1)
- Provider health history enables reliability trend analysis
- Stage errors are surfaced in CLI output with provider context
- Circuit breaker state persists across restarts
- Graceful shutdown drains connections before force-exit
- Scheduler warmup no longer silently fails via `.unref()`

### Negative
- Sequential failover adds up to 1s latency per domain when the
  primary server is down (500ms delay × up to 2 fallbacks)
- Three new files: `FailoverRdapProvider`, `provider_health` migration,
  health repository
- Existing `PublicRdapProvider` constructor signature changed (baseUrl
  and name parameters added); tests updated

### Compliance and Security Implications
- No new compliance requirements — all bootstrap servers are public
  RDAP endpoints operated by ICANN-accredited registries
- More outbound connections from production deployment; firewall rules
  must allow HTTPS to all bootstrap URLs

### Migration and Monitoring Plan
1. **Migration**: Existing deployments continue using default bootstrap
   URLs — no `.env` change required. Custom bootstrap URLs can be set
   via `RDAP_BOOTSTRAP_URLS`.
2. **Rollout**: Single deployment — the `FailoverRdapProvider` replaces
   `PublicRdapProvider` directly in `composition-root.ts`.
3. **Monitoring**: New `GET /api/health/providers/history` endpoint
   exposes per-provider availability trends.
4. **Rollback**: Revert to `new PublicRdapProvider(rateLimiter)` in
   `composition-root.ts` if failover behaviour causes issues.

### Validation
- Pipeline runs that previously failed due to rdap.org downtime now
  succeed via fallback (verified via integration tests with mock failover)
- CLI output shows yellow warnings when a provider degrades
- `GET /api/health/providers` returns circuit breaker state for each provider
- Graceful shutdown tested via `kill -SIGTERM <pid>` with active requests

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`.*
