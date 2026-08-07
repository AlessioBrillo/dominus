# ADR-0044: DNS Consensus Budget and DoH Keep-Alive Pooling

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-07 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0002, ADR-0039, ADR-0041, ADR-0042 |
| **Project** | DOMINUS |

## Context

The 2-of-3 DNS consensus gate (ADR-0039) is the fail-closed availability
guard: every `Available` verdict from the primary resolver must be confirmed
by a second, independent resolver strategy. Three structural weaknesses made
that guarantee both unreliable and expensive under load:

1. **Shared rate-limit budget.** The consensus secondary drew from the *same*
   `DNS_RATE_LIMIT_*` bucket as the primary. A heavy acquisition run — which
   is exactly when the gate matters most — consumed the shared tokens, and
   the second opinion could be throttled or starved while the primary raced
   ahead. The two providers' budgets counted against each other inside one
   bucket, so verification capacity was a zero-sum trade with primary
   throughput.
2. **Unbounded verification stampede.** The consensus phase reused the
   primary batch pacing. `DNS_BULK_CONCURRENCY` defaults to 200, the size of
   a heavy acquisition batch; letting the secondary re-query at the same
   parallelism doubles the resolver traffic of an already-heavy run and can
   flap the resolver endpoints the gate depends on.
3. **Per-query DoH connection churn.** Every DoH lookup used `fetch` on the
   global one-shot dispatcher: a fresh TLS + HTTP handshake per query. A bulk
   run paying handshake cost per domain multiplied connection setup traffic
   and defeated keep-alive.

A separate, pre-existing defect compounded these: `checkAvailability` shared
its in-flight lookup between coalesced callers by promising a single
`#pending` entry, **but bound the wire query to the first caller's
`AbortSignal`**. When that caller's run was aborted, the shared lookup was
terminated as `aborted` → `Unknown` for every peer — a cancelled run could
manufacture an `Unknown` verdict for domains it never actually finished
querying, then cache it for the run.

## Decision

Four bounded, independent controls, each fail-safe on its own axis:

### 1. Dedicated consensus rate budget

The secondary provider owns a dedicated token bucket
(`DNS_CONSENSUS_RATE_LIMIT_TOKENS`/`_INTERVAL_MS`, default 20 req/sec burst
20), built by `buildConsensusRateLimiter` and wired separately from the
primary in `BuildDnsConsensusConfig`/`composition-root`. In the Redis/
cloud topology it lives in its own namespace (`dns-consensus`) with the
ADR-0041 per-tenant fair-share windows (`DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_*`).
A primary burst can no longer starve the gate, and vice versa.

### 2. Independent consensus concurrency ceiling

The consensus verification phase is bounded by
`DNS_CONSENSUS_BULK_CONCURRENCY` (default 20, range 1–500), independent of
`DNS_BULK_CONCURRENCY`. The secondary is fail-closed but now provably bounded:
its parallelism cannot spike with the primary batch size.

### 3. DoH keep-alive pooling

All DoH requests route through a `DohAgentPool` — a single undici `Agent`
(origin-aware; one connection pool per origin, `DNS_DOH_MAX_CONNECTIONS`
sockets each, default 64) — instead of the one-shot global dispatcher.
`dispatcherFor(endpoint)` returns the shared, stable instance; `fetch(url,
{ dispatcher })` reuses warm connections and queues excess load in undici. A
bulk run pays one connection-pool setup per provider, not one per query.

### 4. Abort-safe request coalescing

The shared in-flight lookup in `NodeDnsProvider.checkAvailability` is
disconnected from the first caller's abort for its **wire queries**: the
caller's signal is honored only for entry pre-abort fail-fast and for the
best-effort parking-IP probe (which must still terminate with a cancelled
run so it cannot hang the shared verdict). The wire lookup completes on its
bounded timeout and returns a real verdict instead of a poisoned `Unknown`.

### Options considered and rejected

- **Keep one shared DNS token bucket (status quo)** — rejected: it makes the
  fail-closed gate a zero-sum loser against the very primary load it guards.
- **Reuse `DNS_BULK_CONCURRENCY` for verification** — rejected: it subjects the
  conservatism gate to full primary burst; a stampede can degrade resolvers
  and amplify itself.
- **Per-query `new Agent` instead of a pool** — rejected: it defeats
  keep-alive; the pool cost is one connection set per origin, amortized.
- **Propagate the initiator's abort into the shared lookup but invalidate
  coalesced peers** — rejected: the shared promise is a single verdict
  object; there is no safe per-peer result to distribute once the query is
  cancelled, short of manufacturing the very `Unknown` the change removes.

## Consequences

### Positive

- The availability gate is no longer starveable by primary load, and cannot
  multiply resolver traffic beyond its own ceiling.
- DoH keeps one warm connection per origin; bulk runs stop paying a
  handshake per query.
- `Unknown` results are no longer manufacturable from another caller's
  aborted run; coalescing now returns real, timeout-bounded verdicts.
- Dedicated budget and ceiling are observable via `dominus_dns_consensus_*`
  and tunable via the six env vars documented in this ADR.

### Negative

- Two token buckets means the consensus secondary may queue (and thus lag)
  even when the primary bucket has spare capacity — latency, not correctness.
- An extra keep-alive Agent is an extra set of idle sockets per origin; idle
  deployments stay connection-free thanks to lazy creation.

### Risks and mitigation

- **Consensus latency** on a busy run: the bounded queue can extend the
  verification phase's wall clock. `DNS_CONSENSUS_BULK_CONCURRENCY` can be
  raised up to 500, and the per-domain lookup timeout already caps each
  query.
- **Socket exhaustion** if `DNS_DOH_MAX_CONNECTIONS` is set very high and
  many origins are raced: keep the default until benchmark evidence
  (`npm run bench:ci`) suggests otherwise; each origin is capped
  independently.

### Related ADRs

- ADR-0002 (scoring conservatism — the gate under guard)
- ADR-0039 (2-of-3 consensus degradation policy)
- ADR-0041 (per-tenant fair-share primitives reused for the Redis budget)
- ADR-0042 (private recursor as the consensus secondary)