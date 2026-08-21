// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0054_create_tenant_custom_prices';

const TENANT_CUSTOM_PRICES_DDL = `
CREATE TABLE IF NOT EXISTS tenant_custom_prices (
  tenant_id TEXT NOT NULL,
  price_id TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL,
  expected_amount_eur INTEGER NOT NULL,
  seats INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, price_id)
)
`;

export function up(db: Database.Database): void {
  db.exec(TENANT_CUSTOM_PRICES_DDL);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_custom_prices_price_id ON tenant_custom_prices(price_id)',
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_custom_prices_tenant ON tenant_custom_prices(tenant_id)');
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(db, TENANT_CUSTOM_PRICES_DDL);
  await execPg(
    db,
    'CREATE INDEX IF NOT EXISTS idx_custom_prices_price_id ON tenant_custom_prices(price_id)',
  );
  await execPg(
    db,
    'CREATE INDEX IF NOT EXISTS idx_custom_prices_tenant ON tenant_custom_prices(tenant_id)',
  );
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS tenant_custom_prices');
}
