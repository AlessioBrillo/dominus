// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0060_create_team_invitations';
export const backwardCompatible = true;

/**
 * Email-addressed team invitations. Until now "inviting" meant writing a
 * pending team_seats row for an opaque user id: nothing was delivered and no
 * one could accept it. An invitation is a single-use bearer token: only its
 * SHA-256 is stored, the plaintext link is shown/emailed once.
 *
 * No tenant_id RLS on purpose: acceptance resolves the row from the token
 * alone, before the accepting user has any tenant context.
 */
const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS team_invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const PG_DDL = `
CREATE TABLE IF NOT EXISTS team_invitations (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
`;

const INDEX_DDL =
  'CREATE INDEX IF NOT EXISTS idx_team_invitations_tenant ON team_invitations(tenant_id, accepted_at)';

export function up(db: Database.Database): void {
  db.exec(SQLITE_DDL);
  db.exec(INDEX_DDL);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec(PG_DDL);
  await db.exec(INDEX_DDL);
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS team_invitations');
}
