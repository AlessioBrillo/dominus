# ADR-0023: Job Queue + Worker Pool Architecture

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-06-16 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0001, ADR-0003, ADR-0005, ADR-0011, ADR-0021, ADR-0022 |
| **Project** | DOMINUS |

## Context

DOMINUS v0.3.0 runs all operations in a single Node.js process: the CLI commands, the Express REST API, the scheduler (node-cron), and the pipeline orchestrator all share the same event loop and SQLite database connection. This architecture has reached its limits:

1. **Blocking CLI operations**: `dominus run` with 5,000+ candidates executes the full pipeline (DNS → Whois → RDAP → Scoring → Trademark) synchronously, blocking the process for 10-60+ minutes. During this time, the API is unresponsive, health checks fail, and no other CLI command can run.

2. **Scheduler contention**: The in-process scheduler runs jobs (backup, portfolio rescore, renewal checks, watchlist polling) on the same event loop. A long-running backup or rescore job starves the event loop, causing API timeouts and missed cron ticks.

3. **SQLite write contention**: Pipeline stages write to `candidates`, `scoring_runs`, `pipeline_runs`, and `trademark_results` concurrently with API read queries. The current `busy_timeout = 5000` is insufficient for bulk operations, leading to `SQLITE_BUSY` errors.

4. **No horizontal scaling path**: The monolithic single-process design prevents running multiple workers for pipeline stages, limiting throughput to ~10 RDAP/sec (single-threaded bottleneck).

5. **Observability gaps**: Job execution state (queued, running, completed, failed, retrying) is not persisted. Operators cannot track long-running operations, and failures leave no audit trail beyond logs.

The project constraints remain: **zero-cost infrastructure** (no Redis, no RabbitMQ, no external queue service), **single-user**, **SQLite persistence**, **TypeScript/Node.js stack**.

## Decision Drivers

1. **Zero-cost mandate** — The job queue must use existing infrastructure (SQLite). No new external dependencies (Redis, PostgreSQL, cloud services) are permitted.

2. **Non-blocking CLI/API** — `dominus run` and `POST /api/v1/runs` must return immediately with a `runId`, allowing the operator to poll for results. The API must remain responsive during heavy workloads.

3. **Durable job execution** — Job state (queued/running/completed/failed/retrying) must survive process restarts. Failed jobs must be automatically retried with exponential backoff and dead-lettered after max attempts.

4. **Concurrency control** — The system must support configurable worker concurrency (default: 2) to maximize throughput while respecting SQLite write limits and external API rate limits.

5. **Backward compatibility** — Existing CLI commands, API endpoints, and scheduler cron jobs must continue working without configuration changes. Migration must be phased and feature-flagged.

6. **Observability as first-class** — Job queue depth, worker status, processing latency, and error rates must be exposed via `/api/v1/health/jobs` and CLI commands.

## Considered Options

### Option A: SQLite-based Job Queue with In-Process Worker Pool (CHOSEN)

A `job_queue` table in SQLite with atomic `dequeue` (SELECT ... FOR UPDATE pattern via `UPDATE ... WHERE id = (SELECT ...)`), a `JobWorker` class running in the same process (or separate process via `WORKER_ENABLED=true`), and handler functions for each job type.

**Advantages:**
- Zero new infrastructure: uses existing SQLite + better-sqlite3
- Atomic dequeue via single UPDATE statement prevents race conditions
- Workers can run in-process (dev) or as separate Node processes (prod) via same codebase
- Job payload/result stored as JSON — flexible for all job types
- Persistent state survives crashes/restarts; stuck jobs auto-requeued on startup
- Priority queue support via `priority` + `scheduled_at` ordering
- Dead letter queue for failed jobs after max retries
- ~200 lines of core infrastructure, minimal maintenance burden

**Disadvantages:**
- SQLite write contention under high concurrency (mitigated: low concurrency default, WAL mode, busy_timeout)
- No native pub/sub for job notifications (polling required, acceptable at DOMINUS scale)
- In-process worker shares event loop with API (mitigated: `WORKER_ENABLED` env var runs worker in separate process)
- Manual scaling: operator must start N worker processes (acceptable for single-user)

**Cost Implications:** ~3 engineering days. Zero operational cost. Zero new dependencies.

**Risk Assessment:** Low. SQLite is already the persistence layer; extending it for queue is a natural evolution. The atomic dequeue pattern is well-documented and tested.

---

### Option B: Redis + BullMQ (REJECTED)

Add Redis as a queue backend with BullMQ for job management, workers, and scheduling.

**Advantages:**
- Battle-tested, high-performance queue with native pub/sub, delayed jobs, rate limiting
- Horizontal scaling: add worker processes on any machine
- Rich dashboard (Bull Board) for monitoring
- Built-in retry, backoff, dead letter, metrics

**Disadvantages:**
- **Violates zero-cost mandate**: Redis requires memory, persistence config, monitoring
- New operational dependency: backup, security, version upgrades
- Adds ~50MB RAM baseline + network latency
- Over-engineered for single-user, <100 jobs/day workload
- Migration from current scheduler requires significant rewiring

**Cost Implications:** ~2 engineering days + ongoing Redis operational cost (VPS RAM, backups). Violates project constraints.

**Risk Assessment:** Medium. Introduces infrastructure complexity disproportionate to DOMINUS scale.

---

### Option C: PostgreSQL + pg-boss / Graphile Worker (REJECTED)

Migrate from SQLite to PostgreSQL and use pg-boss or Graphile Worker for job queue.

**Advantages:**
- ACID-compliant queue with SKIP LOCKED for true concurrent dequeue
- Single database for all data (queue + domain data)
- Mature ecosystem, horizontal scaling

**Disadvantages:**
- **Violates zero-cost mandate**: PostgreSQL requires separate process, more RAM, backups
- **Massive migration**: All 21 existing migrations + repositories + queries must be ported
- Single-user SQLite is optimal for DOMINUS scale; Postgres adds complexity without benefit
- Breaks "offline-first" — PostgreSQL requires network service

**Cost Implications:** ~15-20 engineering days for full migration. Ongoing Postgres operational cost.

**Risk Assessment:** High. Migration risk is substantial; zero measurable benefit at current scale.

---

### Option D: Temporal.io / Workflow Engine (REJECTED)

Adopt a durable execution platform (Temporal, Inngest, Hatchet) for pipeline orchestration.

**Advantages:**
- Durable execution: automatic retries, timeouts, visibility
- Built-in saga patterns for multi-step pipelines
- Excellent observability and replay

**Disadvantages:**
- **Requires external service** (Temporal Cloud or self-hosted cluster) — violates zero-cost
- Steep learning curve, new programming model (workflows/activities)
- Overkill for DOMINUS: pipeline is linear, not a complex saga
- Vendor lock-in risk

**Cost Implications:** Significant operational cost + learning investment.

**Risk Assessment:** High. Architectural mismatch for a linear pipeline.

---

## Decision

**Chosen option: Option A — SQLite-based Job Queue with In-Process Worker Pool**

Rationale:
1. **Zero-cost compliance**: Uses only existing SQLite. No new infrastructure.
2. **Solves root causes**: Non-blocking CLI/API (driver 2), durable execution (driver 3), concurrency control (driver 4).
3. **Minimal code surface**: ~200 lines for queue + worker + ~100 for worker + handlers. Low maintenance.
4. **Phased migration**: `WORKER_ENABLED=false` (default) keeps current behavior; `WORKER_ENABLED=true` activates worker. Scheduler enqueues instead of running inline.
5. **Extensible**: New job types = one handler file + registry entry. No queue changes.
6. **Observability built-in**: Queue stats, job history, dead letter table — all queryable via SQL.

Rejected alternatives fail driver 1 (zero-cost) or introduce disproportionate complexity (drivers 5, 6).

## Consequences

### Positive
- `dominus run` returns in <100ms with `runId`; operator polls `dominus runs show <runId>` or `GET /api/v1/runs/<runId>`
- API healthcheck always responsive — workers run independently (separate process if configured)
- Pipeline runs, backtest, portfolio rescore, backup, watchlist, renewal checks all use same queue
- Automatic retry with exponential backoff (configurable) + dead letter after `maxAttempts`
- Stuck jobs (worker crash mid-job) auto-requeued on next worker startup via `requeueStuck()`
- Priority support: urgent jobs (user-triggered run) jump ahead of scheduled maintenance

### Negative
- SQLite write contention risk at high concurrency (mitigated: `WORKER_CONCURRENCY=2` default, `busy_timeout=30000`)
- Polling-based status check (no push notifications) — acceptable for CLI/API poll UX
- In-process worker mode still shares event loop (mitigated: production should use `WORKER_ENABLED=true` separate process)
- Manual worker process management (systemd, PM2, or Docker) required for production deployment

### Compliance and Security Implications
- No new attack surface: queue is internal SQLite table, no network exposure
- Job payloads may contain domain names (PII-adjacent) — already covered by existing SQLite file permissions
- API authentication (ADR-0017) applies to job status endpoints
- No secrets in job payload — providers use env vars / config, not job data

### Migration and Monitoring Plan
1. **Phase 1 (this ADR)**: Create `job_queue` table, `JobQueueRepository`, `JobWorker`, handlers. `WORKER_ENABLED=false` default.
2. **Phase 2**: Refactor `PipelineRunService.run()` to enqueue job. Update CLI `run-command` to enqueue + poll option. Update API `POST /runs` to return 202.
3. **Phase 3**: Refactor `SchedulerService` to enqueue jobs instead of running inline.
4. **Phase 4**: Enable `WORKER_ENABLED=true` in production env. Deploy worker as separate process.
5. **Rollback**: Set `WORKER_ENABLED=false` — all logic reverts to synchronous execution via `PipelineRunService.run()`.

**Metrics for success:**
- `dominus run` response time < 200ms (p99)
- API `/health` response time < 50ms during pipeline run
- Zero `SQLITE_BUSY` errors in logs
- Job completion rate > 99.5% (retries handle transient failures)

### Validation
- Integration test: CLI enqueue → worker processes → result persisted → API poll returns result
- Load test: 10 concurrent pipeline runs (100 domains each) — verify queue processes all, no deadlocks
- Chaos test: Kill worker mid-job → verify job requeued and completed on restart
- Soak test: Scheduler enqueues 50 jobs over 24h — verify all completed, no memory leaks

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`. Template: `.claude/skills/adr/template.md`.*