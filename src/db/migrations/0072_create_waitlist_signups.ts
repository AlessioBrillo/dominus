// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0072_create_waitlist_signups';
export const backwardCompatible = true;

/**
 * First-party waitlist with proof of consent.
 *
 * An external form gives the operator no record of which version of the
 * privacy notice the person accepted, or when. The waitlist is a contact
 * list, not a workspace, so it lives in its own control-plane table: the
 * person has no tenant yet. The token is stored hashed (single use) and the
 * consent version and timestamp are recorded with the address.
 */
const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS waitlist_signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  consent_version TEXT NOT NULL,
  consent_at TEXT NOT NULL DEFAULT (datetime('now')),
  token_hash TEXT NOT NULL UNIQUE,
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const PG_DDL = `
CREATE TABLE IF NOT EXISTS waitlist_signups (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  consent_version TEXT NOT NULL,
  consent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  token_hash TEXT NOT NULL UNIQUE,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
`;

export function up(db: Database.Database): void {
  db.exec(SQLITE_DDL);
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS waitlist_signups');
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec(PG_DDL);
}
