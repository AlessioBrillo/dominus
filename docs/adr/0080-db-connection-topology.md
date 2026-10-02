# ADR-0080: DB Connection Topology — Single Writer, Explicit Lifecycle, Read-Your-Write

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Date** | 2026-10-02 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0005, ADR-0023, ADR-0027, ADR-0033, ADR-0054, ADR-0061 |
| **Project** | DOMINUS |

## Context

The October 2026 read/write split introduced `createReadReplica()` and
`createWriteConnection()` on `DatabaseProvider` plus a separate
`bulkWriteProvider` in the composition root. The intent was correct:
isolate bulk pipeline writes from API reads and reduce `SQLITE_BUSY`
contention. The wiring, however, landed without an ADR and with three
load-bearing defects:

1. **Five handles on one SQLite file.** Per process: main `provider`,
`readProvider`, `writeProvider`, `bulkWriteProvider`, plus the legacy
raw `better-sqlite3` singleton via `openDatabase()`. With api/worker/
scheduler sharing `./data` over a bind-mount, up to 15 handles contend
on one WAL file. SQLite has a single writer; extra connections do not
add write throughput, they add lock churn masked by a 60s busy timeout.
2. **Orphaned lifecycle.** `createDependencies()` creates `readProvider`
and `writeProvider` but never exposes or closes them. Shutdown in
`src/index.ts` closes `provider`, `bulkWriteProvider`, and the legacy
singleton — never the read/write pair. Long-lived deploys leak file
descriptors and WAL readers.
3. **Two write paths.** `PipelineOrchestrator` applies busy-timeout
policy via `writeProvider` while `PipelineRunService` persists via
`bulkWriteProvider`. On SQLite these are different connections with
different `synchronous` settings (`NORMAL` vs default) and different
busy timeouts (60s vs 5s). On PostgreSQL they are two identical
`max: 3` pools. Lock acquisition (`provider`) and write (`writeProvider`
/ `bulkWriteProvider`) are never in the same transaction, and
read-your-write across `readProvider`/`writeProvider` is untested.

PostgreSQL does not share the SQLite single-writer constraint, but the
current four-pool layout (main + read 10 + write 3 + bulk 3) still
doubles the write pools for no reason and doubles tenant-context
(`app.tenant_id`) surface in `PostgresAdapter`.

This ADR fixes the topology before any Enterprise-tier work builds on it.

## Decision Drivers

1. **Correctness over throughput** — A pipeline write visible on the
next API read is mandatory. `POST /runs` followed by `GET /runs/:id`
must never return stale state, on either dialect.
2. **Single writer on SQLite** — WAL allows concurrent readers during a
write, but only one writer at a time. Topology must reflect that
instead of pretending parallel writers exist.
3. **Explicit lifecycle** — Every opened connection or pool is tracked
in `DominusDependencies` and closed on shutdown. No orphaned handles.
4. **One write path** — Exactly one write-optimized provider per
process. Orchestrator policy and run-service persistence use the same
handle.
5. **Operational simplicity** — Same code path on SQLite and
PostgreSQL, with dialect-specific tuning confined to the adapters.

## Considered Options

### Option A: Single writer + read replica + explicit lifecycle (Chosen)

One main provider (locks, admin, migrations), one read provider (API
reads), one write provider (all bulk writes: orchestrator busy-timeout
policy AND run-service persistence). `bulkWriteProvider` is removed
from the composition root; `PipelineRunService` receives the shared
`writeProvider`. All three providers are exposed on
`DominusDependencies` and closed in reverse order (write, read, main)
after worker/scheduler stop and HTTP drain.

SQLite tuning: read `busy_timeout=5s + synchronous=FULL`,
write `busy_timeout=60s + synchronous=NORMAL`, main keeps configured
`DATABASE_BUSY_TIMEOUT`. PostgreSQL tuning: main pool default, read
pool `max 10`, write pool `max 3`. `createReadReplica()` and
`createWriteConnection()` become required interface methods since both
adapters implement them.

**Advantages:**
- Eliminates the duplicate write pool/connection on both dialects.
- Shutdown leak closed; descriptor count per process drops from 5 to 3
(+ legacy singleton pending removal).
- Read-your-write becomes testable on one defined pair instead of three
possible pairs.
- Required interface methods remove the `!` non-null assertion crash
surface in the composition root.

**Disadvantages:**
- Still three SQLite connections on one file; WAL single-writer
contention remains and must be managed via timeouts and short
transactions.
- Existing `bulkWriteProvider` field on `DominusDependencies` is a
breaking change for direct consumers; mitigated by keeping the field as
a deprecated alias for one release.

**Cost Implications:** Dev effort ~1 day (wiring + lifecycle + two
integration tests). No infra or licensing cost. Negligible runtime
change: one fewer pool/connection per process.

**Risk Assessment:**
- Technical: Low — pure wiring, no SQL or schema change.
- Migration: Zero — no migration, no env var change.
- Vendor: None.

---

### Option B: Single shared provider (revert the split)

Remove `readProvider`/`writeProvider` entirely. All repositories share
the main provider; contention handled only by `DATABASE_BUSY_TIMEOUT`
and short transactions.

**Advantages:**
- Simplest possible topology; zero extra handles; no read-your-write
question because there is only one connection.
- Removes the `synchronous=FULL vs NORMAL` durability asymmetry.

**Disadvantages:**
- Reintroduces the original problem: bulk DNS/RDAP writes block API
reads for the full transaction duration, with `SQLITE_BUSY` tail
latency on concurrent runs.
- Throws away the valid isolation work already landed and tested.
- PostgreSQL loses read/write pool separation that genuinely helps
under mixed OLTP + bulk load.

**Cost Implications:** Dev effort ~half day (revert + test updates).
Operational cost: higher p99 API latency during large runs.

**Risk Assessment:**
- Technical: Low but directionally wrong for cloud multi-tenancy.
- Migration: Zero.
- Vendor: None.

---

### Option C: Full connection manager with leasing and fencing

Introduce a `ConnectionManager` that leases read/write handles per
operation with fencing tokens, queue-depth metrics, and automatic
retry on `SQLITE_BUSY`. Repositories never hold a provider; they ask
the manager per query.

**Advantages:**
- Finest-grained control; per-operation timeouts; observable queue.
- Could enforce read-your-write by pinning a request to the write
connection for a bounded window after a write.

**Disadvantages:**
- Major complexity: new abstraction over every repository call,
dozens of call-site changes, new failure modes (lease exhaustion,
fence mismatch).
- Disproportionate to the problem scope; DOMINUS avoids extra
distributed machinery (ADR-0018 spirit).
- Weeks of work with high regression risk right before release
engineering safety work (v1.1.0).

**Cost Implications:** Dev effort ~2 weeks. Operational: new metrics
and runbooks for lease pressure.

**Risk Assessment:**
- Technical: High — touches every repository.
- Migration: Medium — behavior change under load.
- Vendor: None.

## Decision

**Chosen option: Option A**

Rationale:
- **Driver 1 (read-your-write):** One defined read/write pair with a
dedicated test is verifiable; three overlapping pairs are not. Option
B is verifiable but regresses latency; Option C is verifiable but
unshippable in this window.
- **Driver 2 (single writer):** Option A names the single writer
explicitly instead of implying two writers. The duplicate PG pools are
provably redundant (identical `max: 3`).
- **Driver 3 (lifecycle):** Only Option A closes the leak. B closes it
by deletion but keeps the latency problem; C adds a manager that itself
needs lifecycle.
- **Driver 4 (one write path):** Only Option A unifies orchestrator
policy and run-service persistence on one handle.
- **Driver 5 (simplicity):** Option A is a wiring change with no new
abstraction; C violates simplicity outright.

Alternatives rejected:
- **B:** Correct but slow; discards real isolation gains on both
dialects.
- **C:** Powerful but disproportionate; wrong layer for this release.

## Consequences

### Positive
- Single write provider per process on both dialects; PG pool count
drops from 4 to 3, SQLite handles from 5 to 4 (3 providers + legacy
singleton).
- Deterministic shutdown order: worker/scheduler stop, HTTP drain,
write close, read close, main close, legacy singleton close.
- `createReadReplica`/`createWriteConnection` required on the
interface; composition root drops `!` assertions.
- Read-your-write covered by an integration test on SQLite and PG
(`pipelineRunsRepo.create` on write, `find` on read).

### Negative
- `bulkWriteProvider` field deprecated but retained one release as an
alias to `writeProvider` to avoid breaking external consumers.
- SQLite still has three connections on one file; operators must keep
transactions short and keep `./data` on a local filesystem (never
NFS/SMB — already documented).

### Compliance and Security Implications
- Tenant isolation unchanged: every PG pool path goes through
`#withConnection` with `set_config('app.tenant_id', ...)` and reset
before release. Fewer pools means smaller tenant-context surface.
- No new secrets, no new network surface, no schema change.
- Durability asymmetry is now explicit and documented: write uses
`synchronous=NORMAL` for throughput, read uses `FULL` for
consistency; both are WAL + foreign-keys enforced.

### Migration and Monitoring Plan
1. Land behind no flag: wiring-only, safe defaults preserved
(`READ 5s/FULL`, `WRITE 60s/NORMAL`).
2. Monitor `SQLITE_BUSY` retry count, pipeline persistence p99, API
read p99 during bulk runs. Expect flat or improved tails from one
fewer contender.
3. Rollback: restore `bulkWriteProvider` creation and pass it to
`PipelineRunService` instead of `writeProvider`. No migration to undo.
4. Follow-up: remove legacy `openDatabase()` singleton once CLI
maintenance moves to the provider abstraction; remove deprecated
`bulkWriteProvider` alias next minor.

### Validation
- Integration test: write on write-provider, read on read-provider,
same row visible immediately (SQLite file + PG when `DATABASE_URL`
set).
- Lifecycle test: `createDependencies` in test harness exposes three
providers; after shutdown hook all report `isOpen() === false`.
- Load spot-check: 50k-candidate bulk write concurrent with API reads
shows no `SQLITE_BUSY` regression vs pre-change baseline.
- Success criteria: zero orphaned handles in shutdown logs; CI
`backend` + `docker-smoke` green.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`.*
