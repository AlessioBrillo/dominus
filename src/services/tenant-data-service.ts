// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../db/provider/interface.js';
import {
  TENANT_SCOPED_TABLES,
  RETAINED_TENANT_TABLES,
  type TenantTable,
} from '../db/tenant-data-registry.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

/**
 * Data-subject rights: export and erasure (GDPR art. 15 and 17).
 *
 * The two operations are the mechanical half of the privacy notice: the
 * notice tells the data subject that the API exposes an export function and
 * a deletion function, and this service is what those functions do.
 *
 * Both walk the same registry (src/db/tenant-data-registry.ts), so what the
 * export returns and what the deletion removes can never disagree.
 *
 * The tenant is never taken from the caller: it is the tenant the request
 * was authenticated for. On PostgreSQL the row-level security policies
 * apply on top of the explicit `WHERE tenant_id = ?`, so a bug in this
 * service still cannot read another tenant's rows.
 */
export interface TenantExportTable {
  table: string;
  rows: Record<string, unknown>[];
  /** True when the table hit the per-table row cap. */
  truncated: boolean;
}

export interface TenantExport {
  tenantId: string;
  generatedAt: string;
  /** Schema and data version, so an export can be interpreted later. */
  formatVersion: 1;
  tables: TenantExportTable[];
  totalRows: number;
  /** Tables whose rows were kept for a legal retention obligation. */
  retainedTables: string[];
}

export interface TenantDeletionTableReport {
  table: string;
  rows: number;
  /** True when the rows were kept instead of deleted. */
  retained: boolean;
}

export interface TenantDeletionReport {
  tenantId: string;
  deletedAt: string;
  tables: TenantDeletionTableReport[];
  totalRows: number;
  /**
   * True when the data is gone from the live database. Backups are outside
   * this scope: the rolling backup window is documented in the privacy
   * notice and in the data processing agreement.
   */
  liveDataErased: true;
}

export interface TenantDataServiceOptions {
  /**
   * Maximum number of rows returned per table in an export. The cap exists
   * so one enormous table cannot exhaust the memory of the API process; when
   * it is reached the table is flagged as truncated rather than silently
   * cut.
   */
  maxRowsPerTable?: number;
}

const DEFAULT_MAX_ROWS_PER_TABLE = 100_000;

export class TenantDataService {
  readonly #provider: DatabaseProvider;
  readonly #maxRowsPerTable: number;

  constructor(provider: DatabaseProvider, options: TenantDataServiceOptions = {}) {
    this.#provider = provider;
    this.#maxRowsPerTable = options.maxRowsPerTable ?? DEFAULT_MAX_ROWS_PER_TABLE;
  }

  /**
   * Everything the service holds about the tenant, as JSON.
   *
   * The export is a snapshot, not a transaction: it is a read of the tenant's
   * data for the data subject, not a consistent database dump.
   */
  async exportTenant(tenantId: string): Promise<TenantExport> {
    const tables: TenantExportTable[] = [];
    let totalRows = 0;

    for (const { table } of TENANT_SCOPED_TABLES) {
      const rows = await this.#provider.query<Record<string, unknown>>(
        `SELECT * FROM "${table}" WHERE tenant_id = ? LIMIT ?`,
        [tenantId, this.#maxRowsPerTable + 1],
      );
      const truncated = rows.length > this.#maxRowsPerTable;
      const kept = truncated ? rows.slice(0, this.#maxRowsPerTable) : rows;
      tables.push({ table, rows: kept, truncated });
      totalRows += kept.length;
    }

    logger.info({ tenantId, tables: tables.length, totalRows }, 'Tenant data exported');

    return {
      tenantId,
      generatedAt: new Date().toISOString(),
      formatVersion: 1,
      tables,
      totalRows,
      retainedTables: [...RETAINED_TENANT_TABLES],
    };
  }

  /**
   * Delete everything the service holds about the tenant.
   *
   * The whole deletion runs in one transaction: a partial erasure is worse
   * than a refused one, because it looks like a completed erasure.
   */
  async deleteTenant(tenantId: string): Promise<TenantDeletionReport> {
    const tables: TenantDeletionTableReport[] = [];
    let totalRows = 0;

    await this.#provider.transaction(async (db) => {
      for (const spec of TENANT_SCOPED_TABLES) {
        const table = spec.table;
        if (spec.retained) {
          const rows = await db.query<Record<string, unknown>>(
            `SELECT * FROM "${table}" WHERE tenant_id = ?`,
            [tenantId],
          );
          tables.push({ table, rows: rows.length, retained: true });
          totalRows += rows.length;
          continue;
        }
        const result = await db.exec(`DELETE FROM "${table}" WHERE tenant_id = ?`, [tenantId]);
        tables.push({ table, rows: result.changes, retained: false });
        totalRows += result.changes;
      }
    });

    logger.info(
      { tenantId, tables: tables.length, totalRows },
      'Tenant data erased (data-subject deletion)',
    );

    return {
      tenantId,
      deletedAt: new Date().toISOString(),
      tables,
      totalRows,
      liveDataErased: true,
    };
  }

  /** The registry, exposed for the routes that describe what will be erased. */
  get tables(): readonly TenantTable[] {
    return TENANT_SCOPED_TABLES;
  }
}
