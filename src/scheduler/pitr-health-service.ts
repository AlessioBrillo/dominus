// SPDX-License-Identifier: AGPL-3.0-only
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
  /** Age in hours of the newest base backup per the PITR manifest, or null
   *  when no backup ever recorded a row (PITR without an anchor). */
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

interface PitrManifestRow {
  finished_at: string | Date;
  base_name: string;
  size_bytes: string | number;
  host: string;
}

const WAL_LAG_SQL = `
  SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), pg_last_archived_wal_lsn()) AS lag_bytes
`;

const MANIFEST_SQL = `
  SELECT finished_at, base_name, size_bytes, host
  FROM pitr_health
  ORDER BY finished_at DESC
  LIMIT 1
`;

export class PitrHealthService {
  readonly #provider: DatabaseProvider;
  readonly #walLagMaxBytes: number;
  readonly #baseBackupMaxAgeHours: number;
  readonly #onCheck: ((result: PitrHealthCheck) => void) | undefined;

  constructor(options: PitrHealthServiceOptions) {
    this.#provider = options.provider;
    this.#walLagMaxBytes = options.walLagMaxBytes;
    this.#baseBackupMaxAgeHours = options.baseBackupMaxAgeHours;
    this.#onCheck = options.onCheck;
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

    const baseBackupAgeHours = await this.#newestBaseBackupAgeHours();
    if (baseBackupAgeHours === null) {
      problems.push(
        'no base backup recorded in the PITR manifest (run deploy/postgres/base-backup.sh)',
      );
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

  /**
   * Age in hours of the newest base backup recorded in the PITR manifest,
   * or null when the manifest is empty or unreadable. The manifest is
   * written by deploy/postgres/base-backup.sh (migration 0053).
   */
  async #newestBaseBackupAgeHours(): Promise<number | null> {
    let row: PitrManifestRow | null;
    try {
      row = await this.#provider.queryOne<PitrManifestRow>(MANIFEST_SQL);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'PITR health: manifest query failed');
      return null;
    }
    if (!row) return null;

    const finishedAt =
      row.finished_at instanceof Date
        ? row.finished_at.getTime()
        : Date.parse(String(row.finished_at));
    if (Number.isNaN(finishedAt)) {
      logger.error(
        { finished_at: row.finished_at },
        'PITR health: manifest row has an unparseable finished_at',
      );
      return null;
    }
    return Math.max(0, (Date.now() - finishedAt) / 3_600_000);
  }
}
