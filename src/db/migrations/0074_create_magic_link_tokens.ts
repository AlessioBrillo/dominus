// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0074_create_magic_link_tokens';
export const backwardCompatible = true;

/**
 * Single-use tokens for passwordless browser sign-in.
 *
 * A separate table is deliberate: `signup_verifications` has a CHECK on
 * `purpose IN ('signup','recovery')`, and widening that constraint would be
 * destructive DDL. Magic-link tokens are control-plane: a person who is not
 * authenticated yet needs to consume one, exactly like a team invitation.
 * Only the SHA-256 of the token is stored.
 */
const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const PG_DDL = `
CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
`;

const INDEX_DDL =
  'CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_email ON magic_link_tokens(email)';

export function up(db: Database.Database): void {
  db.exec(SQLITE_DDL);
  db.exec(INDEX_DDL);
}

export function down(db: Database.Database): void {
  db.exec('DROP INDEX IF EXISTS idx_magic_link_tokens_email');
  db.exec('DROP TABLE IF EXISTS magic_link_tokens');
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec(PG_DDL);
  await db.exec(INDEX_DDL);
}
