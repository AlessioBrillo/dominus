# ADR-0105: Metering counts the work, not the reads

## Metadata

| Field          | Value                                                                 |
|----------------|-----------------------------------------------------------------------|
| **Status**     | Accepted                                                              |
| **Date**       | 2026-11-11                                                            |
| **Authors**    | Alessio Brillo                                                        |
| **Deciders**   | Alessio Brillo                                                        |
| **Supersedes** | -                                                                     |
| **Relates to** | ADR-0038, ADR-0026                                                    |
| **Project**    | DOMINUS                                                               |

## Context

The usage meter recorded one `api_calls` unit for **every** request that
reached the protected router. The plan limits are 1.000 calls a month on
the free plan, 10.000 on Pro and 50.000 on Team.

The dashboard is a React application that reads: every page load issues
several requests, the query cache refetches, the runs page polls. A
customer using the product normally - opening the dashboard, looking at
the candidates, checking the portfolio - consumed the monthly allowance
in a few hours and then met a 429 on a page that had nothing to do with
the work the platform does. The free plan, which exists to let a stranger
try the product, was unusable in practice.

The meter also wrote a counter row for every GET: a read-heavy workload
multiplied the write traffic of the primary database by the number of
page views, in a deployment whose PostgreSQL node is sized for one
application replica.

The limits that describe the work are already there and they are the ones
that matter: `candidates_scored` (the scoring runs, the expensive part)
and `domains_tracked`. The `api_calls` limit protects the API from a
client that hammers it; the per-IP rate limit already does that job at
the edge.

## Decision

1. **Only the requests that change something are metered.**
   `createUsageEnforcementMiddleware` records a unit for POST, PUT, PATCH
   and DELETE, and passes the read-only requests through without
   recording. The behaviour is configurable (`meterReads`), and the
   default stays "reads are free".
2. **The plan is gated by the limits that describe the work.** The
   scoring quota and the tracked-domains quota are the ones that decide
   whether a tenant can keep using the product; `api_calls` remains a
   coarse guard against a client that writes in a loop.
3. **The control-plane routes are never metered** (`/usage`, `/billing`,
   `/system`, `/keys`): the customer must always be able to see their
   consumption, manage their keys and manage their subscription.

## Consequences

### Positive

- The dashboard does not consume the customer's allowance: the free plan
  survives a normal day of use.
- The read-heavy workload does not write to the primary database.
- The usage numbers the customer sees describe the work, not the number
  of clicks.

### Negative / trade-offs

- A tenant that only reads (a monitoring script polling the runs
  endpoint) is not metered. The per-IP rate limit and the per-token rate
  limit are what protect the platform from it.
- The meaning of `api_calls` changed: it is now "the operations that
  change something". The usage screen and the plan descriptions must say
  so, and the limit values are a historical artifact.

### When this is revisited

When the product sells an API-first tier, the API-only endpoints get
their own metered feature (`api_calls` for the paths that are not part of
the dashboard), so that an integrator is billed for the calls they make
without the dashboard competing for the same counter.
