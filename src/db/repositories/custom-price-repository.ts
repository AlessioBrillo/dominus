// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';
import type { TenantCustomPrice, TenantCustomPriceRow } from '../../types/subscription.js';
import { customPriceFromRow } from '../../types/subscription.js';
import { resolveTenantId } from '../../utils/tenant-context.js';

export class CustomPriceRepository {
  readonly #db: DatabaseProvider;

  constructor(db: DatabaseProvider) {
    this.#db = db;
  }

  async findByPriceId(priceId: string): Promise<TenantCustomPrice | undefined> {
    const row = await this.#db.queryOne<TenantCustomPriceRow>(
      'SELECT * FROM tenant_custom_prices WHERE price_id = ?',
      [priceId],
    );
    return row ? customPriceFromRow(row) : undefined;
  }

  async findByTenantId(tenantId?: string): Promise<TenantCustomPrice[]> {
    const tid = resolveTenantId(tenantId);
    const rows = await this.#db.query<TenantCustomPriceRow>(
      'SELECT * FROM tenant_custom_prices WHERE tenant_id = ? ORDER BY created_at DESC',
      [tid],
    );
    return rows.map(customPriceFromRow);
  }

  async upsert(price: {
    tenantId: string;
    priceId: string;
    plan: string;
    expectedAmountEur: number;
    seats: number;
  }): Promise<void> {
    await this.#db.exec(
      `INSERT INTO tenant_custom_prices (tenant_id, price_id, plan, expected_amount_eur, seats)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(price_id) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         plan = excluded.plan,
         expected_amount_eur = excluded.expected_amount_eur,
         seats = excluded.seats`,
      [price.tenantId, price.priceId, price.plan, price.expectedAmountEur, price.seats],
    );
  }

  async delete(priceId: string): Promise<boolean> {
    const result = await this.#db.exec('DELETE FROM tenant_custom_prices WHERE price_id = ?', [
      priceId,
    ]);
    return result.changes > 0;
  }

  async deleteByTenant(tenantId: string): Promise<number> {
    const result = await this.#db.exec('DELETE FROM tenant_custom_prices WHERE tenant_id = ?', [
      tenantId,
    ]);
    return result.changes;
  }
}
