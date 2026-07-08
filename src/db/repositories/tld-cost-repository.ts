import type { DatabaseProvider } from '../provider/interface.js';

export interface TldCostRow {
  id: number;
  tld: string;
  renewalCostEur: number;
  registrar: string | null;
  updatedAt: string;
}

interface TldCostDbRow {
  id: number;
  tld: string;
  renewal_cost_eur: number;
  registrar: string | null;
  updated_at: string;
}

function rowToEntry(row: TldCostDbRow): TldCostRow {
  return {
    id: row.id,
    tld: row.tld,
    renewalCostEur: row.renewal_cost_eur,
    registrar: row.registrar,
    updatedAt: row.updated_at,
  };
}

/**
 * Repository for TLD-level renewal cost overrides.
 * The scoring and portfolio layers use this to resolve per-TLD renewal
 * costs instead of relying on a single DEFAULT_RENEWAL_COST_EUR.
 */
export class TldCostRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async findByTld(tld: string): Promise<TldCostRow | null> {
    const row = await this.db.queryOne<TldCostDbRow>(
      'SELECT * FROM tld_renewal_costs WHERE tld = ?',
      [tld],
    );
    return row ? rowToEntry(row) : null;
  }

  async findAll(): Promise<TldCostRow[]> {
    const rows = await this.db.query<TldCostDbRow>(
      'SELECT * FROM tld_renewal_costs ORDER BY tld ASC',
    );
    return rows.map(rowToEntry);
  }

  async upsert(tld: string, renewalCostEur: number, registrar?: string): Promise<void> {
    await this.db.exec(
      `INSERT INTO tld_renewal_costs (tld, renewal_cost_eur, registrar, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(tld) DO UPDATE SET
         renewal_cost_eur = excluded.renewal_cost_eur,
         registrar = COALESCE(excluded.registrar, tld_renewal_costs.registrar),
         updated_at = datetime('now')`,
      [tld, renewalCostEur, registrar ?? null],
    );
  }

  async delete(tld: string): Promise<void> {
    await this.db.exec('DELETE FROM tld_renewal_costs WHERE tld = ?', [tld]);
  }
}
