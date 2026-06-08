# ADR-0008: Backtest engine — joining predictions to outcomes with point-in-time correctness

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-06-06 |
| **Authors** | DOMINUS team |
| **Deciders** | DOMINUS team |
| **Supersedes** | N/A |
| **Relates to** | ADR-0007 (backtest_signals schema), ADR-0009 (weight recalibration) |
| **Project** | DOMINUS |

## Context

The `backtest_signals` table (ADR-0007) is a static data structure — it does
nothing by itself. We need an engine that:

1. **Populates** the table by joining `outcomes` (where type='sold' and
   sale_price_eur is set) with the `scoring_runs` row that was the last
   available prediction at the time of the sale.
2. **Aggregates** the populated table into a `BacktestReport` the operator
   can read: MAE, bias, buy-max hit rate, and a per-confidence-bucket
   calibration table.

The non-trivial piece is the join. A naive "latest scoring_runs row for
this domain" query is wrong: a re-run of the pipeline months after a sale
will have written a *new* scoring_runs row, and joining naively would
silently treat a 2026 prediction as the engine's "answer" to a 2025 sale.
That would make the engine look much better than it actually was at
decision time, defeating the calibration purpose.

The fix is point-in-time correctness: for each outcome, the join must pick
the `scoring_runs` row whose `scored_at <= outcome.occurred_at` is
maximal. This is the prediction that *was actually available* when the
operator decided to acquire the domain.

## Decision Drivers

1. **Point-in-time correctness** — the prediction row used in the join
   must be the one available *before* the outcome occurred, not the
   latest row.
2. **Idempotency** — `dominus backtest --rebuild-snapshot` must be safe
   to re-run; the engine must never duplicate signal rows.
3. **Sold-only scope** — per the v0.3 product decision, only
   `outcomes.type = 'sold'` outcomes feed the backtest. Dropped,
   expired, and renewed are not "truth" the engine should be held to.
4. **No paid APIs / no ML libraries** — the engine uses only stdlib and
   the existing repositories, consistent with vision §6 (heuristic
   only) and the cost discipline principle.
5. **Testability** — every behaviour (point-in-time join, idempotency,
   empty case) must be covered by a unit test on `:memory:` SQLite.

## Considered Options

### Option A: Two-method engine — `snapshot()` + `report()` (CHOSEN)

Two clearly separated methods on `BacktestEngine`:

- `snapshot()`: scan sold outcomes, derive the point-in-time scoring row
  for each, UPSERT into `backtest_signals`. Returns
  `{ scanned, inserted, skipped }`.
- `report()`: pure read of `backtest_signals` that returns a
  `BacktestReport` aggregate.

**Advantages:**
- Clear separation: writes are explicit (`snapshot()`), reads are
  read-only (`report()`). The CLI can call them in any order or skip
  either.
- `report()` is testable in isolation by pre-seeding signals — no need
  to mock the outcomes repo.
- The `excludedNoPrediction` / `excludedNoOutcome` counters in the
  report are computed in `snapshot()` and travel naturally with the
  signal rows; the report just trusts the snapshot table.
- All heuristics live in one file. Easy to audit.

**Disadvantages:**
- Two-step CLI workflow (`snapshot` then `report`) is more steps than
  a single combined call. We accept this in exchange for explicitness.
- `report()` on a stale snapshot table could mislead. The CLI's
  default will be to call `snapshot()` first, so this is mitigated at
  the edge.

**Cost Implications:** Trivial. No new dependencies. ~150 lines of code
+ 8 unit tests. All pure computation on the existing repos.

**Risk Assessment:** Low. The point-in-time join is the riskiest part
and is covered by a dedicated test (`picks the LAST snapshot whose
scored_at <= occurredAt`).

---

### Option B: Single combined `run()` that snapshots and reports in one call

One method that does both, returns a single combined result.

**Advantages:**
- Simpler CLI: one call, one output.

**Disadvantages:**
- Hard to inspect "what does the snapshot look like?" without
  recomputing the report.
- Tests for the aggregation logic would have to seed outcomes *and*
  scoring_runs, making them slower and more coupled.
- Re-running the report without rebuilding the snapshot (e.g. to
  answer a one-off "what was the MAE 3 months ago?") is impossible
  without re-snapshotting.

**Cost Implications:** Slightly less code. Higher test cost.

**Risk Assessment:** Low. Just a worse trade-off.

---

### Option C: Push the join into a SQL view, do the aggregation in SQL

`CREATE VIEW v_backtest_signals AS SELECT … FROM outcomes o JOIN scoring_runs sr ON …`
and aggregate inside SQL.

**Advantages:**
- All logic in one place (the DB).
- No application-side join to maintain.

**Disadvantages:**
- SQLite view does not let us materialise the unique-by-pair semantics;
  every report query would re-derive the join from `outcomes` and
  `scoring_runs`, not from a stable `backtest_signals` table. We
  lose idempotency at the storage layer.
- The "audit" property of ADR-0007 — replaying the report against the
  state at time T — is broken. The view is recomputed live; the
  `backtest_signals` table is a frozen snapshot.
- Window functions to pick the last row before a timestamp work but
  the resulting query is hard to test in isolation.

**Cost Implications:** Lower code volume. Higher conceptual cost.

**Risk Assessment:** Medium. The audit story is the whole point of the
feature, and a view defeats it.

## Decision

**Chosen option: Option A — two-method engine with point-in-time join**

The split into `snapshot()` and `report()` is intentional. The CLI in
ADR-…(commit 3) will default to `snapshot()` before `report()` so the
operator never reads stale data, but the engine itself stays
decomposable for testing and future use (e.g. a "compare two
backtest runs" view in a future dashboard).

The point-in-time join (`scored_at <= outcome.occurred_at`, ordered
DESC, limit 1) is the load-bearing piece of the engine. It is covered
by a dedicated test, and ADR-0007's unique index guarantees that
re-running `snapshot()` never produces duplicate signals.

## Consequences

### Positive
- **Reproducible backtests.** Two operators running `snapshot()` on
  the same database get the same `backtest_signals` rows in the same
  order. Calibration discussions become evidence-based.
- **Idempotency is structural, not application-enforced.** The
  `(outcome_id, scoring_run_id)` unique index in ADR-0007 means we
  can re-run the snapshot any number of times.
- **Sold-only scope keeps the metric honest.** Mixing "dropped" with
  "sold" would dilute the MAE and make it useless for setting
  `suggested_buy_max`. The engine is explicit about this in code and
  in the report's `sampleSize` field.
- **Empty case is well-defined.** A portfolio with zero sold outcomes
  returns a zeroed report and the CLI prints a clear "no data yet"
  message.

### Negative
- **No automatic snapshot refresh.** The CLI must call `snapshot()`
  before `report()` or accept stale data. We mitigate by making
  `snapshot()` the default in the CLI command.
- **Two-step API.** Slightly more surface to learn. Worth it for the
  testability and the audit story.
- **Point-in-time join assumes `scored_at` is a reliable ISO
  timestamp.** A backfilled scoring run with `scored_at` in the future
  would be picked up as "available at decision time" even though it
  wasn't. We accept this risk because the only writer of
  `scored_at` is the pipeline orchestrator, and it always writes the
  current time.

### Compliance and Security Implications
- No new external calls, no new attack surface. The engine reads only
  from the local SQLite database.
- The point-in-time join avoids a subtle information leak: the report
  does not include predictions that were made *after* the operator
  could have acted on them.

### Migration and Monitoring Plan
- **Migration:** The engine has no schema. It only reads from
  `outcomes`, `candidates`, `scoring_runs`, and writes to
  `backtest_signals` (created in ADR-0007).
- **Rollout:** Available as soon as the CLI command is shipped
  (commit 3 of this series). The first call with an empty
  `outcomes` table returns an empty report — no failure modes.
- **Monitoring:** A simple assertion: `backtest_signals.count() <= sum(sold outcomes with sale_price_eur)`. If violated, the
  engine is producing duplicates; the unique index should have
  prevented that.
- **Rollback:** The engine is pure code, no schema impact. Revert
  the commit.

### Validation
- Unit tests in `backtest-engine.test.ts` cover: snapshot inserts
  one row per sold outcome, skips outcomes without sale_price or
  without prior scoring, picks the LAST snapshot before occurredAt,
  is idempotent, and computes MAE/bias/hit-rate/calibration
  correctly.
- Integration validation: a "test portfolio" of 3 domains seeded
  with outcomes at different dates should produce exactly 3 signal
  rows and a `BacktestReport` whose `sampleSize` is 3.
- Production validation: first real backtest on the operator's
  actual portfolio. Empty `backtest_signals` after a `--rebuild-snapshot`
  is the failure signal (point-in-time join is wrong).

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`.
Template: `/home/aledio/Documents/Project/dominus/.claude/skills/adr/template.md`.*
