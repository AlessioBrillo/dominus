// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseProvider } from '../db/provider/interface.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface PitrHealthCheck {
  /** True when this instance runs PostgreSQL (PITR is a PG concept). */
  applicable: boolean;
  /** WAL lag in bytes between the current position and the last archived
   *  segment. Null when archiving has never produced a segment. */
  walLagBytes: number | null;
  /** False when `pg_last_archived_wal_lsn()` is NULL — archiving never
   *  confirmed a segment, so PITR is silently off. */
  archivingActive: boolean;
  /** Age in hours of the newest `base-*` backup directory, or null when
   *  no base backup exists yet (PITR without an anchor). */
  baseBackupAgeHours: number | null;
  /** Overall health verdict: lag within budget, archiving active and a
   *  fresh base backup present. */
  ok: boolean;
  /** Human-readable reasons when !ok (for the scheduler job result). */
  problems: string[];
  checkedAt: string;
}

export interface PitrHealthServiceOptions {
  provider: DatabaseProvider;
  /**
   * Directory where base backups (and pg_dump files) are stored — the
   * same BACKUP_DIR the scheduler/worker mount. Base backups are
   * directories named `base-*` created by deploy/postgres/base-backup.sh.
   */
  backupDir: string;
  /** Maximum acceptable WAL archiving lag before PITR risk is declared. */
  walLagMaxBytes: number;
  /** Maximum age of the newest base backup before PITR risk is declared. */
  baseBackupMaxAgeHours: number;
  /**
   * Optional hook fired after every check — used to record the
   * dominus_pitr_* gauges.
   */
  onCheck?: (result: PitrHealthCheck) => void;
}

const BASE_BACKUP_PREFIX = 'base-';

const WAL_LAG_SQL = `
  SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), pg_last_archived_wal_lsn()) AS lag_bytes
`;

export class PitrHealthService {
  readonly #provider: DatabaseProvider;
  readonly #backupDir: string;
  readonly #walLagMaxBytes: number;
  readonly #baseBackupMaxAgeHours: number;
  readonly #onCheck: ((result: PitrHealthCheck) => void) | undefined;

  constructor(options: PitrHealthServiceOptions) {
    this.#provider = options.provider;
    this.#backupDir = resolve(options.backupDir);
    this.#walLagMaxBytes = options.walLagMaxBytes;
    this.#baseBackupMaxAgeHours = options.baseBackupMaxAgeHours;
    this.#onCheck = options.onCheck;
  }

  /** Newest base backup directory name (assists tests and drills). */
  static baseBackupPrefix(): string {
    return BASE_BACKUP_PREFIX;
  }

  async check(): Promise<PitrHealthCheck> {
    const checkedAt = new Date().toISOString();
    if (this.#provider.dialect !== 'postgres') {
      return {
        applicable: false,
        walLagBytes: null,
        archivingActive: false,
        baseBackupAgeHours: null,
        ok: true,
        problems: [],
        checkedAt,
      };
    }

    const problems: string[] = [];
    const walLagBytes = await this.#readWalLag();
    const archivingActive = walLagBytes !== null;

    if (!archivingActive) {
      problems.push('no WAL segment ever archived (archive_mode/archive_command not working)');
    } else if (walLagBytes! > this.#walLagMaxBytes) {
      problems.push(`WAL lag ${walLagBytes} bytes exceeds budget ${this.#walLagMaxBytes} bytes`);
    }

    const baseBackupAgeHours = this.#newestBaseBackupAgeHours();
    if (baseBackupAgeHours === null) {
      problems.push('no base backup found in BACKUP_DIR (run deploy/postgres/base-backup.sh)');
    } else if (baseBackupAgeHours > this.#baseBackupMaxAgeHours) {
      problems.push(
        `newest base backup is ${baseBackupAgeHours.toFixed(1)}h old (budget ${this.#baseBackupMaxAgeHours}h)`,
      );
    }

    const ok = problems.length === 0;
    if (!ok) {
      logger.warn({ problems, checkedAt }, 'PITR health degraded');
    }
    const result: PitrHealthCheck = {
      applicable: true,
      walLagBytes,
      archivingActive,
      baseBackupAgeHours,
      ok,
      problems,
      checkedAt,
    };
    this.#onCheck?.(result);
    return result;
  }

  /**
   * Read the archiving lag. node-postgres returns BIGINT/numeric as a
   * string, hence the Number() coercion. NULL means no segment was ever
   * archived — treated as "archiving inactive".
   */
  async #readWalLag(): Promise<number | null> {
    try {
      const row = await this.#provider.queryOne<{ lag_bytes: string | null }>(WAL_LAG_SQL);
      return row?.lag_bytes === null || row?.lag_bytes === undefined ? null : Number(row.lag_bytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'PITR health: WAL lag query failed');
      return null;
    }
  }

  /** Age in hours of the newest base-* directory, or null when none exists. */
  #newestBaseBackupAgeHours(): number | null {
    if (!existsSync(this.#backupDir)) return null;
    let newestMs = -1;
    for (const entry of readdirSync(this.#backupDir)) {
      if (!entry.startsWith(BASE_BACKUP_PREFIX)) continue;
      try {
        const mtimeMs = statSync(join(this.#backupDir, entry)).mtimeMs;
        if (mtimeMs > newestMs) newestMs = mtimeMs;
      } catch {
        continue;
      }
    }
    if (newestMs < 0) return null;
    return Math.max(0, (Date.now() - newestMs) / 3_600_000);
  }
}
