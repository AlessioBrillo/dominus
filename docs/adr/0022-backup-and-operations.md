# ADR-0022: Database Backup Strategy and Production Operations

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-06-13 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0001, ADR-0005 |
| **Project** | DOMINUS |

## Context

DOMINUS stores all persistent state in a single SQLite file (`dominus.db`). As
the portfolio grows and the backtest history accumulates, this database
becomes the single most critical asset in the system:

- All pipeline runs, scoring history, and candidate data
- Portfolio entries, renewal dates, acquisition costs
- Trademark cache and provider cache (rate-limited API responses)
- Backtest signals and weight snapshots (the calibration loop)

Despite this criticality, v0.2.0 had **zero backup automation**:

1. No scheduled backup job existed in the scheduler.
2. No automated pre-migration snapshot was taken before schema changes.
3. No integrity verification was run periodically.
4. The operator had to manually `cp` the database file, which produces an
   inconsistent copy when WAL mode is active (the copy may miss uncheckpointed
   WAL pages or include partially-written transactions).

Concurrently, the GitHub Actions CI minutes were exhausted, making the remote
quality gate unavailable. The project needed a local fallback that runs the
same checks (typecheck, lint, test, build) before every push, enforced by a
pre-push git hook that was already present but under-documented.

## Decision Drivers

1. **Consistency** — Backups must be transaction-consistent. A file-level copy
   of a SQLite database in WAL mode is NOT consistent. `VACUUM INTO` is the
   only safe mechanism for hot backups in single-user SQLite.
2. **Automation** — Backups must run on a schedule without operator
   intervention. The scheduler (ADR-0021) is the natural home for this.
3. **Retention discipline** — Unlimited backups consume disk space silently.
   A retention policy with automatic pruning is mandatory.
4. **Local CI gate** — Without GitHub Actions, the pre-push hook must run the
   full quality suite (typecheck, build, lint, format, test) and block the
   push on failure.
5. **Observability** — The operator must be able to list, inspect, and
   manually trigger backups and vacuum operations from the CLI.

## Considered Options

### Option A: `VACUUM INTO` + retention pruning + scheduler job (CHOSEN)

A dedicated `BackupService` class that:
- Calls `PRAGMA wal_checkpoint(TRUNCATE)` to flush the WAL
- Runs `VACUUM INTO '<path>'` to create a transaction-consistent snapshot
- Prunes backups older than `BACKUP_RETENTION_DAYS` (default: 30)
- Is wired into the scheduler as a daily job (cron: `0 4 * * *`)
- Is available from the CLI via `dominus maintenance backup` and
  `dominus maintenance vacuum`

**Advantages:**
- `VACUUM INTO` produces a fully consistent, compacted copy — even if the
  source database has accumulated free pages from deletions, the backup
  contains only live pages
- The backup is a standalone SQLite file; no external tools required
- No downtime — `VACUUM INTO` is atomic in single-user mode
- Scheduler integration means the operator never has to remember
- Retention pruning prevents unbounded disk growth

**Disadvantages:**
- `VACUUM INTO` requires free disk space equal to the source database size
  (transient; the source is unmodified)
- Daily backup of a mostly-static database is wasteful (accept: small scale)

**Risk Assessment:** Low. `VACUUM INTO` is a mature SQLite feature.
Single-user mode guarantees no concurrent writers during the backup.

### Option B: `.backup` command via `sqlite3` CLI

Use the SQLite `.backup` command or the `backup_api` C API.

**Advantages:**
- Incremental backup support via `sqlite3_backup_step()`
- Online backup without blocking readers

**Disadvantages:**
- Requires shelling out to the `sqlite3` binary
- The `better-sqlite3` Node.js bindings expose `backup()` but it uses
  callbacks and is more complex to integrate into the scheduler
- `VACUUM INTO` produces a smaller output (no free pages)

**Risk Assessment:** Low, but more complex to wire into Node.js async flow.

### Option C: File-level copy with WAL checkpoint

Simply copy the database file after `PRAGMA wal_checkpoint(TRUNCATE)`.

**Advantages:**
- Simple. One copy command.

**Disadvantages:**
- NOT consistent if a write transaction commits between the checkpoint and
  the copy (though single-user mode mitigates this)
- The copy contains free pages; no compaction
- Does not detect corruption in the source file

**Risk Assessment:** Medium. In single-user mode the window is narrow, but
the copy is provably unsafe if any async write completes between the
checkpoint and the copy.

## Decision

**Chosen option: Option A — `VACUUM INTO` + retention pruning + scheduler job**

We accept the transient disk space cost in exchange for absolute consistency
guarantees and zero operational overhead. The `BackupService` is a single
class (~100 lines) that integrates cleanly with the existing scheduler
(ADR-0021) and CLI infrastructure.

The local CI gate is implemented as a `.husky/pre-push` hook that runs
`npm run prepush`, which executes `ci:backend` (typecheck → build → lint →
format → test with coverage). This was already partially present but not
enforced or documented as the primary quality gate.

## Consequences

### Positive

- **Consistent backups**: Every backup is a transaction-consistent snapshot
  via `VACUUM INTO`. Safe for restore at any point.
- **Zero-touch operations**: Daily backup + prune is fully automated via the
  scheduler. The operator never has to remember.
- **CLI visibility**: `dominus maintenance backup --list`, `dominus
  maintenance vacuum`, and `dominus maintenance prune` give the operator
  full control.
- **Local CI**: The pre-push hook catches type/lint/test failures before
  they reach the remote, compensating for the exhausted GitHub Actions
  minutes.
- **Integrity verification**: `dominus maintenance vacuum` runs
  `PRAGMA integrity_check` before vacuuming, catching corruption early.

### Negative

- **Disk space**: Each backup is a full copy of the database. At current
  scale (MBs), this is irrelevant. If the database grows to GBs, consider
  switching to incremental backup or reducing retention.
- **WAL checkpoint side-effect**: Running `PRAGMA wal_checkpoint(TRUNCATE)`
  during the backup job forces a WAL flush, which may cause a brief
  write stall. In single-user mode this is imperceptible.

### Compliance and Security Implications

- Backup files may contain domain names, portfolio entries, and trademark
  data. The .gitignore already excludes `data/` — no backup file can be
  committed. The operator is responsible for securing the backup directory.
- No credentials or API keys are stored in the database; all secrets live
  in environment variables or file-based config.

### Migration Plan

- **No schema migration required.** The backup is purely a file-system
  operation. The `BackupService` creates `./data/backup/` on first run.
- A new migration (`0017`) is NOT required — the scheduler job is registered
  dynamically based on `BackupService` availability, not from the
  `scheduler_jobs` table. Adding a static migration would be beneficial for
  persistence of the job metadata but is deferred (low priority).

## Validation

1. **Unit tests**: `src/scheduler/__tests__/backup-service.test.ts` covers
   backup creation, pruning, listing, and edge cases (empty dir, missing dir,
   corrupted file names).
2. **Integration**: Run `dominus maintenance backup` with a test database,
   verify the output file opens with `PRAGMA integrity_check`.
3. **Scheduler**: Enable `SCHEDULER_ENABLED=true`, wait for the backup cron
   (or use `dominus scheduler run-once backup`), verify backup appears in
   `./data/backup/`.
4. **CI gate**: Make a deliberate type error, commit, try to push — verify
   the pre-push hook rejects the push.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the ADR series starting at `docs/adr/0001-project-architecture.md`.*
