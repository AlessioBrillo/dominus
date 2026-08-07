# ADR-0038: Usage Enforcement

## Metadata

| Field          | Value                                                      |
| -------------- | ---------------------------------------------------------- |
| **Status**     | Accepted                                                   |
| **Date**       | 2026-08-07                                                 |
| **Authors**    | AlessioBrillo                                              |
| **Deciders**   | AlessioBrillo                                              |
| **Supersedes** | N/A                                                        |
| **Relates to** | ADR-0025, ADR-0026, ADR-0027, ADR-0029, ADR-0031, ADR-0037 |
| **Project**    | DOMINUS                                                    |

## Context

DOMINUS Cloud monetises managed infrastructure, not features (ADR-0025,
ADR-0026). Every community-edition feature is available to Cloud tenants, so
the commercial boundary is the _server-side allowance consumed by each
tenant_, not a feature gate. Before enforcement, nothing bounded how many
domains a tenant could track or how many pipeline runs they could execute —
a single tenant could consume unbounded CPU, RDAP traffic, and storage,
raising the marginal cost of every other tenant on the shared instance.

The community edition is single-user and runs at €0 infrastructure cost. It
must stay zero-cost and unencumbered: usage enforcement is a Cloud concern,
and the enforcement engine must be a no-op on self-hosted deployments.

Three resources map naturally to metered features:

1. **`candidates_scored`** — pipeline work (candidate generation + DNS
   pre-filter + RDAP + scoring + trademark gate). Consumed in proportion to
   the size of a run input.
2. **`api_calls`** — request-volume guard for the shared API surface.
3. **`domains_tracked`** — the portfolio/watchlist footprint: one row per
   tracked domain, bounded at the plan limit.

Metering must happen at well-defined chokepoints so each unit is counted
exactly once, and enforcement must fail **before** any irreversible work
starts, so a rejected tenant does not leave behind orphaned rows, dead-letter
jobs, or half-applied `pipeline_runs` records.

## Decision Drivers

1. **Zero-cost community default** — enforcement off by default
   (`USAGE_ENFORCEMENT_ENABLED=false`); when disabled the service never
   records, so self-hosted installs have no extra writes or failure modes.
2. **Validate before work** — a usage rejection must happen before the
   resource is consumed (job created, row inserted), never after.
3. **Count each unit exactly once** — one chokepoint per metered feature, no
   double-counting across synchronous and asynchronous paths.
4. **Transactional consistency** — a unit consumed by a metered operation
   that then fails must be refunded, so accounting reflects real capacity.
5. **Bookkeeping flows must not double-bill** — acquired domains added to a
   portfolio as a result of a purchase/auction resolution are already
   charged real money; the tracking allowance must not additionally swallow
   them.

## Considered Options

### Option A: Hard per-unit consumption gates at every call site

Instrument every call site that touches a metered feature and decide inline
whether the tenant is over allowance.

**Advantages:**

- Simple to understand at each site.
- No cross-cutting middleware required except for volume.

**Disadvantages:**

- The same unit can be counted by two call sites with no top-level
  authority, so sync and async paths drift.
- Unless every call site is audited, paths double-count.
- No single chokepoint to attach "reject before work" semantics.

**Cost Implications:** High ongoing audit burden; risk of drift.

**Risk Assessment:** High risk of double counting and race conditions.

---

### Option B: Chokepoint metering with `usageMetered` hand-off

Every metered feature has a single, known injection point. All orchestrating
paths funnel through it, and the metering decision is carried forward in the
job payload (`usageMetered`) so the worker executing the run never charges a
second time.

**Advantages:**

- One source of truth per feature; sync and async converge on the same
  `PipelineRunService` method.
- Rejection happens before any row or job exists — no ghost rows, no
  dead-letter jobs.
- Middleware for `api_calls` is the only cross-cutting path, and it is
  layered on the same `UsageMeterService` primitive.

**Disadvantages:**

- Requires discipline to route every path through the chokepoint.
- The hand-off flag is carried on job payloads; it must be trusted to come
  only from the enqueue chokepoint.

**Cost Implications:** One middleware per feature + one flag field.

**Risk Assessment:** Low, provided the flag is set only by the enqueue
chokepoint.

---

### Option C: Retrospective metering from `pipeline_runs` rows

Charge tenants after the fact by scanning `pipeline_runs` results and
portfolio rows on a schedule, deriving consumed units from persisted state.

**Advantages:**

- Always exact per-candidate counts; no estimates.
- No inline metering code at chokepoints.

**Disadvantages:**

- Enforces **after** work ran — a runaway tenant still consumes unbounded
  infrastructure before any rejection.
- Requires a reconciliation job and backfill logic; error-prone under
  pruning (ADR-0022) and retention windows.

**Cost Implications:** Medium (scheduler job, reconciliation queries).

**Risk Assessment:** High for the primary goal (bounding consumption before
work happens). Viable only as a billing reconciliation layer, not as an
enforcement mechanism.

## Decision

**Chosen option: Chokepoint metering with `usageMetered` hand-off (Option B).**

Each metered feature is measured at exactly one chokepoint, all orchestrating
paths funnel through it, and the job payload carries a `usageMetered` flag so
the worker never double-charges. Enforcement is gated behind
`USAGE_ENFORCEMENT_ENABLED`, default `false` — in the disabled state the
`PipelineUsageEnforcer` reports unlimited capacity and never records, keeping
the community edition a behavioural no-op and at zero cost.

### Metered features and chokepoints

| Feature             | Chokepoint                                   | Unit                                                                                                                           | Enforced before work                        |
| ------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `candidates_scored` | `PipelineRunService.enqueueRun` / `runSync`  | candidate-count of the run input, per the shared enforcer (provisional input-size basis until per-run actual counts are wired) | yes — rejects before a job is enqueued      |
| `api_calls`         | Express `usageEnforcement` middleware        | 1 per request                                                                                                                  | yes — rejects before the route handler runs |
| `domains_tracked`   | `PortfolioManager.add` and the watchlist add | 1 per add                                                                                                                      | yes — rejects before the row is written     |

The `candidates_scored` chokepoint is deliberately conservative: the
enqueue-time estimate `estimateCandidateCount` (expanded keywords ×
brandables + closeouts) is the figure charged. If the estimate undershoots
the actual per-candidate work, usage is under-counted only in the safe
direction for the provider (the tenant pays for what was quoted). Recalibrating
the estimate is a tuning task, not an accounting fix. When enforcement is
off, no unit is ever recorded and no allowance check runs.

### Reject-before-consume ordering

For `candidates_scored` the enqueue path in `PipelineRunService.enqueueRun` runs
in two steps: (1) `UsageMeterService.record` the estimate — which raises
`UsageLimitExceededError` when the allowance is exhausted — then (2) only
after successful metering, `pipeline_runs.insert` + `jobQueue.enqueue`.
This rejects before the pipeline run row and any job exist: no ghost
`pipeline_runs` row, no dead-letter job.

Similarly `PortfolioManager.add` and the watchlist add first meter
`domains_tracked`, then insert. If the insert throws (e.g. duplicate 409),
the metered unit is **refunded** via `UsageRepo.decrementUsage` so the
tenant's allowance reflects only live rows.

Purchase/auction bookkeeping passes `skipUsageMeter: true`: domains acquired
through a paid flow are not double-charged by allowance tracking.

### Failure policy

- **Reject before work, fail loudly.** A call over allowance raises
  `UsageLimitExceededError` synchronously at the chokepoint.
- **Refund on transactional failure.** Insert-into-tracked-tables failures
  refund the metered unit (see above).
- **No refund on downstream degradation.** A job that is correctly metered at
  enqueue and then fails during execution (dead letter, timeout, transient
  provider error) is NOT refunded: the job consumed the infrastructure even
  if the outcome was partial. `degraded` runs (ADR-0037) are still consumed.
  Refunds are only for "metered but not actually used" — i.e. a chokepoint
  that consumed a unit then failed before any work happened.

### API contract

`UsageLimitExceededError` maps to **HTTP 429** with a structured body so
clients can render allowance UI:

```json
{
  "error": { "code": "USAGE_LIMIT_EXCEEDED", "message": "..." },
  "usage": { "feature": "candidates_scored", "current": 50, "requested": 2, "limitValue": 50 }
}
```

`requested` is the number of units being attempted in this operation. This
schema is stable regardless of feature (see `error-handler.ts`).

### Plans

| Plan       | candidates_scored | api_calls | domains_tracked |
| ---------- | ----------------- | --------- | --------------- |
| free       | 50                | 1000      | 25              |
| pro        | 500               | 10000     | 250             |
| enterprise | unlimited         | unlimited | unlimited       |

Seeded in migration 0045, read from the `plan_feature_limits` table and
joined to each tenant via `plan_name`. Enterprise entries are `NULL`, meaning
"unmetered/unlimited".

## Consequences

### Positive

- Infrastructure consumption per tenant is bounded by plan allowance, so a
  bulk pipeline run cannot put unbounded work on the shared instance.
- The same codebase serves community (enforcement off; zero record, zero
  failure) and Cloud (enforcement on) with no feature gating (ADR-0025,
  ADR-0026).
- Metered units are consumed at chokepoints with `precede-before-work`
  ordering, so rejections never orphan rows or queue jobs.
- Bookkeeping flows (purchases, auction wins) are explicitly carve-out via
  `skipUsageMeter`, so real-money flows don't vanish (and the portfolio
  count can't be DoSed by acquisition).

### Negative

- `candidates_scored` is charged on the input estimate, not on actual
  candidates processed. A run whose actual candidate count diverges from the
  estimate overcharges/undercharges. Mitigated by conservative direction:
  the tenant is charged what the UI quoted at enqueue time.
- A tenant that enqueues many jobs in a burst is still rate-limited by
  allowance before the DB. Fine.
- `skipUsageMeter: true` is an explicit carve-out that must not spread to
  user-initiated adds — enforced by review.

### Risks and mitigation

- **Ghost-run rejection**: rejecting before job dispatch means a rejected
  user gets a clean 429, not a queued run. Accepted.
- **Flag spoofing**: a `usageMetered: true` payload could in theory skip
  recording. Only our own enqueue chokepoint creates such payloads; jobs
  picked up by the worker are executed only from `job_queue` written by the
  same service. Low risk.
- **Allowance drift under refunds**: `refund` decrements with a floor at
  zero; usage never goes negative; the decrement is upsert-guarded so it
  never creates rows.
- **Route coverage**: 429 is surfaced at the correct layer and covered by
  route-level tests under `src/api/__tests__` and
  `src/api/routes/__tests__`.

### Migration and Monitoring Plan

- **Rollout**: default is off; no behavior change on self-hosted. Cloud
  enables `USAGE_ENFORCEMENT_ENABLED=true`; plans are seeded via migration 0045.
- **Monitoring**: watch the rate at which `UsageLimitExceededError` 429s
  are returned per tenant (should approximate expected allowance
  utilization), and the refund count (which should be near-zero and only
  correlated with duplicate-add attempts).

### Validation

- Feature-flagged `on` in Cloud staging; run a pipeline past the free-plan
  `candidates_scored` allowance and confirm 429 with no `pipeline_runs`
  row and no job. Portfolios cannot exceed `domains_tracked` unless the add
  is a purchase/auction bookkeeping flow.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. *
