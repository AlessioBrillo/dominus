# ADR-0011: pipeline_runs schema — durable history of every pipeline execution

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-06-07 |
| **Authors** | DOMINUS team |
| **Deciders** | DOMINUS team |
| **Supersedes** | N/A |
| **Relates to** | ADR-0007 (backtest_signals), ADR-0008 (backtest engine), ADR-0009 (weight recalibration), ADR-0010 (rescore bridge) |
| **Project** | DOMINUS |

## Context

A `dominus run` today is a write-only operation. The orchestrator emits
`runId`, `stageSummary` (per-stage passed/filtered/duration), and
`totalDurationMs` to stdout, then forgets them. The `runId` string is
denormalised onto `candidates.pipeline_run_id` and `scoring_runs.run_id`
but the run as a logical event has no record. The consequences are real:

1. **No point-in-time auditability.** The backtest engine (ADR-0008)
   performs `scored_at <= outcome.occurred_at` joins, but cannot answer
   "which run produced this scoring snapshot?" without an implicit join
   through `candidates.pipeline_run_id` — a denormalised string that
   gives no way to ask what the run was *about*.
2. **No run history view.** The operator cannot list past runs, compare
   MAE between runs, see how long a run took, or identify runs that
   failed. A "compare two backtest runs" view (mentioned in ADR-0008's
   future-work) is impossible without a runs table.
3. **No retention policy.** As `scoring_runs` accumulates, the operator
   has no knob to prune. The only way to recover disk is a manual SQL
   sweep.
4. **No host version pinning on runs.** A run today does not record
   which DOMINUS version produced it. Comparing a 2025 score against a
   2026 score after a refactor is not safe — the algorithm might have
   changed.

The obvious shape of the fix is a `pipeline_runs` table with one row
per run, carrying the metadata the orchestrator already produces. But
two design decisions are non-trivial: (a) what fields to denormalise
versus store as JSON, and (b) whether to retain runs forever or
adopt a TTL.

## Decision Drivers

1. **Audit immutability** — runs are events that happened. Once written,
   they should not be edited, only completed.
2. **Query ergonomics** — the operator should be able to list runs by
   date range, look up one run by id, and read the per-stage summary
   without parsing JSON. Top-level fields for `started_at`,
   `total_duration_ms`, and `retained_until` belong as columns.
3. **Retention control** — at single-user scale (tens of runs per year)
   the table stays small, but the operator must have a knob to prune.
   180 days default; configurable via env; explicit `prune` command
   rather than implicit vacuum.
4. **Forward-only schema** — like every other migration, the new table
   must be additive. No backfill, no destructive change.
5. **No coupling to scoring_runs** — the runs table is the *event log*;
   the scoring rows are the *predictions*. They are joined by
   `run_id` string, not by FK, so a future refactor of either side
   does not break the other.

## Considered Options

### Option A: Top-level columns + JSON summary blobs (CHOSEN)

A `pipeline_runs` table with:

- `run_id` (PK, UUID text)
- `started_at`, `finished_at` (ISO text)
- `total_duration_ms` (integer)
- `stage_summary` (JSON text: `{StageName: {passed, filtered, durationMs}}`)
- `inputs` (JSON text: `{keywords, brandableNames, closeoutDomains, closeoutEntries}`)
- `results_summary` (JSON text: `{candidatesEvaluated, recommended, trademarkBlocked, unscored}`)
- `host_version` (text: package.json version)
- `retained_until` (ISO text: started_at + 180 days)
- `error` (text, nullable: captured exception message on failure)

Indexes on `started_at` (default sort order) and `retained_until`
(supports the prune query).

**Advantages:**
- Querying by date is a single column compare, not a JSON_EXTRACT.
- `retained_until` is a first-class column, not buried in JSON.
- Top-level fields survive schema changes to the JSON payloads.
- Pluggable JSON: future versions can add new fields to
  `stage_summary` without a migration.

**Disadvantages:**
- Two-level schema (columns + JSON) is slightly more code than
  pure-JSON. A single `payload` column would be simpler.
- The `inputs` JSON snapshot can grow large for big closeout CSV
  imports. We accept this; the JSON is the truth the run actually
  saw.

**Cost Implications:** Trivial. One migration, one repository, ~150 LOC
+ tests. No new dependencies.

**Risk Assessment:** Low. Forward-only migration on a brand new table.
Empty backfill. Cascade impact: none (no FKs).

---

### Option B: Single JSON payload column

Store the entire run as one JSON blob, query via SQLite JSON1
functions. `run_id` is still PK for fast lookup.

**Advantages:**
- Minimal schema. Future schema evolution is "change the JSON shape",
  not "add a column".
- Trivial to serialise/deserialise.

**Disadvantages:**
- Every "list runs" query is `ORDER BY json_extract(payload, '$.started_at')`,
  which prevents the use of an index on started_at and gets slower as
  the table grows. At 1000 rows this is fine; at 100k it hurts.
- `retained_until` would be a computed column or stored redundantly
  inside the JSON, with prune needing a JSON path expression.
- The architecture-guardian §3 rule "no JSON for queryable data" is
  softly violated — we *do* want to query by date.

**Cost Implications:** Lower code volume, higher query cost.

**Risk Assessment:** Low technical, medium long-term (query degradation).

---

### Option C: Separate normalised tables (pipeline_runs + pipeline_run_stages + pipeline_run_inputs)

Normalise the run into 3 tables: `pipeline_runs` (one row per run,
metadata), `pipeline_run_stages` (one row per stage per run), and
`pipeline_run_inputs` (one row per input domain per run).

**Advantages:**
- Cleanest relational shape. Stage rows are first-class queryable.
- Per-domain input history.

**Disadvantages:**
- 3 tables for a feature that is mostly read-once. The "list runs"
  view needs a JOIN.
- Per-stage rows are write-once: we never query "all stage 3
  failures across all runs" because the operator does not have that
  question.
- The per-domain input history already lives in
  `candidates.pipeline_run_id` (denormalised on candidates). Adding
  a `pipeline_run_inputs` table is duplicate state.
- Most "queries" are "show me one run". A single normalised table
  covers 95% of the use cases; the rest is operator-initiated and
  can use SQL.

**Cost Implications:** Higher code volume, more migrations, more
repository classes. The complexity is not justified at single-user
scale.

**Risk Assessment:** Low technical, medium complexity (more code paths
to maintain).

## Decision

**Chosen option: Option A — top-level columns + JSON summary blobs.**

The split mirrors the way the orchestrator already thinks: top-level
fields are *facts* the operator will filter and sort by (when, how
long, until when). JSON blobs are *evidence* the operator will read
once when investigating a run. SQLite indexes work natively on
columns; JSON is for inspection, not filtering.

`run_id` is the primary key as a string (not auto-increment integer)
because:

1. The orchestrator generates the UUID before any row is written
   (so the run can be referenced by other rows that may be created
   in parallel).
2. Cross-system uniqueness: a future cloud-based worker could
   generate a UUID locally and have it collide-safe with the local
   DB.
3. The `candidates.pipeline_run_id` column is already a string and
   references this table by value, not by FK.

`retained_until = started_at + 180 days` is the default. The operator
can override per-run by setting `PIPELINE_RUNS_TTL_DAYS` in `.env`,
or prune manually with `dominus runs prune [--older-than-days N]`.
180 days gives six months of "what did the engine do recently?"
visibility — enough to cross-compare two adjacent closeout-batch
imports.

The table has no FK to other tables. Joins are by string equality
on `run_id`. This is deliberate: deleting a run (e.g. via prune) is
a defensible operator action and must not cascade into
`scoring_runs` or `candidates`. The relationship is "these candidates
participated in this run", not "this run owns these candidates".

## Consequences

### Positive
- **Auditable run history.** Every `dominus run` leaves a permanent
  record of when it ran, what it consumed, what it produced, and how
  long it took.
- **Retention knob.** `dominus runs prune` keeps the table bounded.
  180-day default is invisible to the operator at single-user scale.
- **Future-proof JSON payloads.** The shape of `stage_summary` and
  `results_summary` can evolve across DOMINUS versions without a
  migration. The reading code tolerates unknown fields.
- **No coupling.** `pipeline_runs` does not depend on `scoring_runs`
  or `candidates`; it sits at the event-log layer.

### Negative
- **Two-level schema.** Columns + JSON is slightly more code than
  pure JSON. We accept this for the indexing benefits.
- **`retained_until` must be respected by ops.** A buggy
  `prune` command could delete runs the operator wanted. The CLI
  defaults to `--dry-run` for `prune` and requires `--force` to
  actually delete.
- **No cross-DB portability.** The JSON blobs assume SQLite's JSON1
  extension. We accept this; the project targets SQLite exclusively.

### Compliance and Security Implications
- No PII, no credentials, no API keys. The `inputs` JSON snapshot
  contains the user's own keyword/brandable/closeout domain lists,
  which the operator entered themselves.
- `retained_until` is a retention policy: the operator's data is
  pruned on a schedule they control. This is GDPR-aligned (the
  operator is the data controller).

### Migration and Monitoring Plan
- **Migration:** `0008_create_pipeline_runs` adds one table and two
  indexes, all `IF NOT EXISTS`. Tested in `:memory:` before commit.
- **Rollout:** Forward-only. Existing databases gain the table at
  startup; no data is touched.
- **Monitoring:** A simple `SELECT COUNT(*) FROM pipeline_runs` after
  a run confirms the row was written. The CLI's `dominus runs list`
  surfaces the same count visually.
- **Rollback:** Drop the table. No foreign data references it from
  outside this layer (joins are by string).

### Validation
- Unit tests in `pipeline-runs-repository.test.ts` cover: insert,
  findById, findAll with date filters, prune by `retained_until`,
  ordering.
- Integration test in `pipeline-runs-integration.test.ts` exercises
  the full flow: a `dominus run` produces 1 `pipeline_runs` row plus
  candidate and scoring rows.
- Production validation: a series of 3+ `dominus run` commands in
  one week should produce 3 rows in `dominus runs list`.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`.
Template: `.claude/skills/adr/template.md`.*
