# ADR-0007: backtest_signals schema for prediction-vs-reality audit

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-06-06 |
| **Authors** | DOMINUS team |
| **Deciders** | DOMINUS team |
| **Supersedes** | N/A |
| **Relates to** | ADR-0008 (backtest engine), ADR-0009 (weight recalibration) |
| **Project** | DOMINUS |

## Context

DOMINUS scores every candidate domain with a heuristic engine and recommends a
`suggested_buy_max`. The `outcomes` table (migration 0006) records what
actually happened — sold, dropped, expired, renewed — for every portfolio
domain. To close the calibration loop (vision §6 and §9) we need a way to
compare the engine's predictions against the realised events, on a per-domain
basis and with full historical context.

The naive approach is to JOIN `outcomes`, `portfolio_entries`, `candidates` and
`scoring_runs` on demand. That is workable for ad-hoc reports but has three
real problems:

1. **No point-in-time correctness.** The latest `scoring_runs` row for a
   domain might have been inserted *after* the outcome occurred (e.g. a
   re-run of the pipeline months after a sale). Joining on "the latest
   score" silently mixes predictions that were not available at decision
   time with predictions that were. Calibration reports that use the wrong
   snapshot overestimate engine accuracy.
2. **Mutable scoring history.** `scoring_runs` rows are inserted on every
   pipeline run and have no FK to outcomes. There is no natural place to
   record the *specific* prediction-vs-reality pairing.
3. **Audit gap.** Without a dedicated table, the operator cannot defend
   "I changed the engine weights from A to B because at the time we had
   these outcomes the engine's MAE was X". A backtest run is itself an
   event that should be replayable.

## Decision Drivers

1. **Audit immutability** — every weight-tweak decision in the future must
   reference a reproducible backtest. That requires a stable, append-only
   join table.
2. **Point-in-time correctness** — the signal row must carry the exact
   `scoring_run_id` whose `scored_at <= outcome.occurred_at` was the last
   prediction available at decision time, never a later one.
3. **Idempotent rebuild** — `dominus backtest --rebuild-snapshot` must be
   safe to re-run. The unique index on `(outcome_id, scoring_run_id)`
   enforces this at the DB layer, not in application code.
4. **Forward-only schema** — migration 0007 must be additive and
   safe on existing databases that already have `outcomes` rows.

## Considered Options

### Option A: Dedicated `backtest_signals` table (CHOSEN)

A new table that pairs each `outcomes` row with the `scoring_runs` snapshot
that was the *last available* at the time of the outcome. One row per
`(outcome_id, scoring_run_id)` pair. Computes and stores derived columns
(`absolute_error_eur`, `signed_error_eur`, `confidence_bucket`) so the report
layer never recomputes them on the fly.

**Advantages:**
- Immutability: a row, once written, never needs to change. Rebuilding
  the snapshot is an UPSERT, not a DELETE/INSERT.
- Point-in-time correctness is enforced by the engine (ADR-0008), not by
  the schema; the schema's job is to store whatever the engine decides.
- Unique index gives idempotency for free.
- Cascade-delete from `outcomes` (already in migration 0006) keeps the
  table consistent when a portfolio entry is removed.

**Disadvantages:**
- One new table + 3 indexes (slight storage cost; small at this scale).
- The schema duplicates fields already present in `scoring_runs` and
  `outcomes`. We accept this because a *join* of mutable tables cannot
  be made immutable.

**Cost Implications:** Trivial. No new dependencies. One forward-only
migration. ~50 lines of repository code. Reuses existing DDL patterns.

**Risk Assessment:** Low. Forward-only migration. Unique index
backfill on an empty table is instant. The schema does not encode any
business logic — all heuristics live in ADR-0008's engine.

---

### Option B: Extend `scoring_runs` with `was_acquired`, `realized_sale_price_eur`, FK to `outcomes`

Add columns to the existing table and backfill them once outcomes exist.

**Advantages:**
- No new table. Slightly less schema surface.
- Querying "all scoring rows for a domain" stays in one place.

**Disadvantages:**
- Most `scoring_runs` rows have NO associated outcome (the candidate was
  never bought). Adding nullable columns creates a permanent "is this
  backtest-relevant?" boolean on every score, polluting the dominant
  use case.
- Migrations on populated tables with backfill logic are
  operationally riskier than additive CREATE TABLE.
- Makes the table do two jobs (engine history + backtest pairs) which
  violates single-responsibility at the schema level.

**Cost Implications:** Lower code volume, but a backfill script is
required and a complex migration is more likely to fail mid-deployment.

**Risk Assessment:** Medium. Backfill scripts on live data are a
classic source of outages, even at single-user scale. Mixing two
concerns in one table also makes future schema changes harder.

---

### Option C: Compute on-the-fly via SQL JOIN, no new table

`SELECT … FROM outcomes o LEFT JOIN scoring_runs sr ON …` directly in the
report query.

**Advantages:**
- Zero new tables. Zero new code paths for storage.

**Disadvantages:**
- Cannot guarantee which `scoring_runs` row is picked without
  application-side filtering. SQLite window functions help but the
  report query becomes complex and hard to test.
- The backtest itself is not an artifact you can replay. "What did the
  MAE look like 3 months ago?" cannot be answered without replaying
  the original engine against historical data.
- Debugging calibration drift becomes "rerun everything from scratch
  and compare" — slow and error-prone.

**Cost Implications:** Lowest development effort at first, but the
operational cost of re-deriving reports every time grows with portfolio
size.

**Risk Assessment:** Low technical risk, but the lack of an audit trail
undermines the whole point of doing backtesting: defending weight
changes against real outcomes.

## Decision

**Chosen option: Option A — dedicated `backtest_signals` table**

We accept the small schema duplication in exchange for an immutable,
replayable, point-in-time-correct audit log. This is the foundation of
the calibration loop promised in vision §6 and §9. The two follow-up
ADRs (0008 engine, 0009 weight suggestions) read from and write to
this table.

The choice was made over Option B because `scoring_runs` already carries
a high write rate from pipeline runs; mixing in outcome data pollutes
its primary purpose. The choice over Option C was straightforward: the
backtest must be an event the operator can replay, not a query that has
to be re-derived on demand.

## Consequences

### Positive
- **Idempotency for free.** Unique index on `(outcome_id, scoring_run_id)`
  makes `--rebuild-snapshot` safe to re-run.
- **Cascade integrity.** Removing an outcome (e.g. test cleanup) wipes
  the paired signal rows automatically.
- **Derived columns cached.** `absolute_error_eur`, `signed_error_eur`,
  `confidence_bucket` are stored so the report's aggregation queries
  stay trivial.
- **Audit defensible.** "Why did we change weights from A to B?" is
  answerable by replaying the report against the snapshot at time T.

### Negative
- **Schema duplication.** `domain`, `predicted_*`, `actual_sale_price_eur`
  already exist elsewhere. This is a deliberate trade-off for immutability.
- **Forward-only.** No backfill. Old outcomes that pre-date this
  migration have no signal row. The backtest report correctly counts
  them as `excludedNoPrediction`.
- **Write amplification on rebuild.** UPSERT touches every row each
  rebuild. At the realistic scale of the project (tens to hundreds of
  sold outcomes per year) this is irrelevant.

### Compliance and Security Implications
- No new attack surface. All writes are parameterised.
- `domain` is stored denormalised (already present in `outcomes`) for
  query convenience; it is not a secret and not user-supplied at the
  signal level — it comes from the application layer.
- No PII, no credentials, no API keys. Compliant with the project's
  zero-PII posture.

### Migration and Monitoring Plan
- **Migration:** `0007_create_backtest_signals` adds one table and three
  indexes, all `IF NOT EXISTS`. Tested in `:memory:` before commit.
- **Rollout:** Forward-only. Existing databases gain the table at
  startup; no data is touched.
- **Monitoring:** A simple `SELECT COUNT(*) FROM backtest_signals` after
  a `--rebuild-snapshot` is enough to confirm the engine wrote what it
  was supposed to. No additional telemetry needed at this scale.
- **Rollback:** Drop the table. No foreign data references it from
  outside the engine layer.

### Validation
- Unit tests in `backtest-signals-repository.test.ts` cover: derivation
  of error columns, confidence bucketing, idempotency, cascade delete,
  domain lookup.
- Integration validation: run `dominus backtest --rebuild-snapshot`
  after seeding test outcomes; assert that `backtest_signals` count
  matches the number of `sold` outcomes with at least one prior scoring
  run.
- Production validation: first real backtest will surface whether the
  point-in-time join (ADR-0008) is wired correctly. An empty
  `backtest_signals` after `--rebuild-snapshot` on a non-empty outcomes
  table is the failure signal.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the product vision in `dominus-product-vision.md`.
Template: `/home/aledio/Documents/Project/dominus/.claude/skills/adr/template.md`.*
