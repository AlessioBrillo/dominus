// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0069_create_tenant_notification_settings';
export const backwardCompatible = true;

/**
 * Where a tenant wants to be told about its own domains.
 *
 * Until now the notification channels were built once from the operator's
 * environment (NOTIFIER_WEBHOOK_URL, NOTIFIER_TELEGRAM_*, NOTIFIER_EMAIL_TO):
 * every alert of every tenant went to the operator. That is the opposite of
 * a SaaS — the customer never hears about the renewal of their own domain,
 * and the operator sees data that is not theirs.
 *
 * One row per tenant. The webhook URL is a secret (it authenticates the
 * receiver) and is stored encrypted with the same envelope as the credential
 * vault (src/utils/secret-box.ts). The Telegram chat id is not a secret; the
 * bot token stays operator-side and is never written to the tenant's row.
 *
 * Control-plane table like tenant_credentials (0066): isolated by the
 * repository through an explicit tenant id, not by RLS, because the
 * scheduler reads it before the tenant context is established.
 */
const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS tenant_notification_settings (
  tenant_id TEXT PRIMARY KEY,
  email TEXT,
  webhook_url_encrypted TEXT,
  telegram_chat_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const PG_DDL = `
CREATE TABLE IF NOT EXISTS tenant_notification_settings (
  tenant_id TEXT PRIMARY KEY,
  email TEXT,
  webhook_url_encrypted TEXT,
  telegram_chat_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
`;

export function up(db: Database.Database): void {
  db.exec(SQLITE_DDL);
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS tenant_notification_settings');
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec(PG_DDL);
}
