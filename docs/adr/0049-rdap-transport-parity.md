# ADR-0049: RDAP Transport Parity — Keep-Alive Pooling and Connection Budget

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-08-09 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0002, ADR-0035, ADR-0044 |
| **Project** | DOMINUS |

## Context

The DNS stack earned a dedicated keep-alive pool and a bounded consensus
budget in ADR-0044. RDAP did not. `PublicRdapProvider.confirm` issues
`fetch(url, { signal })` through undici's global one-shot dispatcher, so
every query pays a fresh TLS + HTTP handshake and inherits undici's default
per-origin socket limits. Under a bulk acquisition run
(`RDAP_BATCH_CONCURRENCY`, default 10), a watchlist poll, and portfolio
renewal checks, the RDAP ecosystem (Verisign `.com`/`.net`, ccTLD registries,
rdap.org routing) is hammered with connection setup that keep-alive would
eliminate.

The `FailoverRdapProvider` also races multiple servers and relies on the
*first definitive answer in input order* — a transport concern that becomes a
correctness concern when a single server's 404 is trusted without an
independent second opinion. This ADR covers the transport half of the parity
(pooling + bounded connections); the consensus gate is ADR-0050.

## Decision

Route every RDAP HTTP request through a shared undici `Agent`, mirroring
`DohAgentPool` (ADR-0044 §3):

1. **`RdapAgentPool`** — a single origin-aware undici `Agent` shared by every
   RDAP server (rdap.org, IANA bootstrap-derived registries, custom
   `RDAP_BOOTSTRAP_URLS`). `dispatcherFor(endpoint)` returns the shared,
   stable instance; `fetch(url, { dispatcher })` reuses warm keep-alive
   connections and queues excess load instead of multiplying handshakes.
   Lazy creation keeps idle deployments connection-free.
2. **`RDAP_MAX_CONNECTIONS`** (default 32, range 1–512) — the `connections`
   budget per origin passed to the undici `Agent`. Independent of
   `DNS_DOH_MAX_CONNECTIONS`; RDAP is a smaller per-run workload but must not
   share the DNS pool.
3. **Iana bootstrap fetch** also routes through the pool (one-shot bootstrap
   refresh), so the whole RDAP transport layer shares one connection budget.

The pool is a static, process-wide concern inside the provider layer: each
`PublicRdapProvider` acquires the shared dispatcher from the pool at request
time rather than holding its own Agent.

### Options considered and rejected

- **Per-query `new Agent`** — rejected: defeats keep-alive, same per-query
  handshake cost, and leaks sockets on every short-lived query.
- **Per-provider (not shared) Agent** — rejected: every bootstrap server
  already shares one rate limiter; a shared Agent mirrors that and bounds
  total sockets to `RDAP_MAX_CONNECTIONS` per origin.
- **Reuse `DNS_DOH_MAX_CONNECTIONS`** — rejected: couples two transport
  budgets with unrelated workloads and semantics.

## Consequences

### Positive

- A bulk run pays one connection-pool setup per RDAP origin, not one
  handshake per query — measurable latency win on `.com`/`.net` and ccTLD
  registry traffic.
- Connection budget is bounded and independently tunable via
  `RDAP_MAX_CONNECTIONS`.
- Idle deployments stay connection-free (lazy pool creation).

### Negative

- An extra keep-alive Agent holds idle sockets per origin while warm.
- No semantic change to verdicts: this is transport-only, so behaviour of
  the failover race is unchanged until ADR-0050.

### Risks and mitigation

- **Socket exhaustion** if `RDAP_MAX_CONNECTIONS` is set very high across
  many origins: keep the default (32) until benchmark evidence suggests
  otherwise; each origin is capped independently by undici.
- **429s on aggressive registries**: unchanged; the existing per-server
  circuit breakers and the `RDAP_RATE_LIMIT_*` bucket still apply.

### Related ADRs

- ADR-0002 (scoring conservatism — the guarantee under guard)
- ADR-0035 (RDAP authoritative bootstrap — the servers being pooled)
- ADR-0044 (DNS consensus budget and DoH pooling — the pattern mirrored)
- ADR-0050 (RDAP consensus — the second half of transport parity)
