// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0076_create_mobile_sessions_and_push';
export const backwardCompatible = true;

/**
 * Mobile credentials and push subscriptions (ADR-0116).
 *
 * A device session is a revocable bearer credential for one installed app.
 * Only its SHA-256 hash is stored, exactly like an API key. A push
 * subscription belongs to that session and carries the platform-specific
 * endpoint and encryption keys; `topics_json` holds the per-topic opt-ins.
 *
 * Both tables are tenant-scoped and RLS-protected by migration 0077, so a
 * missing tenant context fails closed instead of exposing a phone's token.
 */
const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS mobile_device_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
)
`;

const PG_DDL = `
CREATE TABLE IF NOT EXISTS mobile_device_sessions (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
)
`;

const SQLITE_PUSH_DDL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  device_session_id INTEGER,
  platform TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT,
  auth TEXT,
  topics_json TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT,
  last_failure_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, endpoint)
)
`;

const PG_PUSH_DDL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  device_session_id INTEGER,
  platform TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT,
  auth TEXT,
  topics_json TEXT NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, endpoint)
)
`;

export function up(db: Database.Database): void {
  db.exec(SQLITE_DDL);
  db.exec(SQLITE_PUSH_DDL);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_mobile_device_sessions_tenant ON mobile_device_sessions(tenant_id)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_push_subscriptions_tenant ON push_subscriptions(tenant_id)',
  );
}

export function down(db: Database.Database): void {
  db.exec('DROP INDEX IF EXISTS idx_push_subscriptions_tenant');
  db.exec('DROP INDEX IF EXISTS idx_mobile_device_sessions_tenant');
  db.exec('DROP TABLE IF EXISTS push_subscriptions');
  db.exec('DROP TABLE IF EXISTS mobile_device_sessions');
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec(PG_DDL);
  await db.exec(PG_PUSH_DDL);
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_mobile_device_sessions_tenant ON mobile_device_sessions(tenant_id)',
  );
  await db.exec(
    'CREATE INDEX IF NOT EXISTS idx_push_subscriptions_tenant ON push_subscriptions(tenant_id)',
  );
}
