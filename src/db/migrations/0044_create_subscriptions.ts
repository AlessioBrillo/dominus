// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0044_create_subscriptions';
export const backwardCompatible = true;

const TENANT_SUBSCRIPTIONS_DDL = `
CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  trial_end TEXT,
  canceled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

export function up(db: Database.Database): void {
  db.exec(TENANT_SUBSCRIPTIONS_DDL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON tenant_subscriptions(tenant_id)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON tenant_subscriptions(stripe_customer_id)',
  );
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(
    db,
    `
    CREATE TABLE IF NOT EXISTS tenant_subscriptions (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL UNIQUE,
      plan TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'active',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      current_period_start TIMESTAMPTZ,
      current_period_end TIMESTAMPTZ,
      trial_end TIMESTAMPTZ,
      canceled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `,
  );
  await execPg(
    db,
    'CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON tenant_subscriptions(tenant_id)',
  );
  await execPg(
    db,
    'CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON tenant_subscriptions(stripe_customer_id)',
  );
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS tenant_subscriptions');
}
