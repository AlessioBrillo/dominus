// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0067_add_email_verification';
export const backwardCompatible = true;

/**
 * Verified ownership of the email that identifies a seat.
 *
 * The self-serve signup creates the owner seat with the EMAIL as the user
 * identifier, because at that moment there is no identity-provider subject.
 * Until now that email was never proven: whoever typed it received an admin
 * API key, and the first person to authenticate through single sign-on with
 * a verified address equal to it inherited the seat (pre-account takeover).
 *
 * Two things change:
 *
 * 1. `team_seats.email_verified_at` records that the seat's email address
 *    was proven by a click on a verification link. The identity resolver
 *    only re-links a seat whose email is verified, so an unverified signup
 *    can never be claimed by whoever owns the mailbox later.
 * 2. `signup_verifications` holds the single-use tokens (only the SHA-256
 *    is stored) used to verify a signup and to recover a lost API key.
 *
 * Control-plane table on purpose: the token is looked up BEFORE any tenant
 * context exists (the caller is not authenticated yet), exactly like
 * team_invitations (0060).
 */
const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS signup_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK(purpose IN ('signup','recovery')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const PG_DDL = `
CREATE TABLE IF NOT EXISTS signup_verifications (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK(purpose IN ('signup','recovery')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
`;

const INDEX_DDL =
  'CREATE INDEX IF NOT EXISTS idx_signup_verifications_email ON signup_verifications(email)';

/** Whether the table already carries the column (the migration is idempotent). */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

export function up(db: Database.Database): void {
  // Idempotent: the rollback of an additive migration leaves the column
  // behind (dropping a column is destructive, and the previous image
  // ignores an extra column), so the migration must be able to run again.
  if (!hasColumn(db, 'team_seats', 'email_verified_at')) {
    db.exec('ALTER TABLE team_seats ADD COLUMN email_verified_at TEXT');
  }
  db.exec(SQLITE_DDL);
  db.exec(INDEX_DDL);
}

export function down(db: Database.Database): void {
  // The column stays: the rollback boots the previous image against the
  // new schema, and an extra column is harmless there. Dropping it would
  // be destructive.
  db.exec('DROP INDEX IF EXISTS idx_signup_verifications_email');
  db.exec('DROP TABLE IF EXISTS signup_verifications');
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec('ALTER TABLE team_seats ADD COLUMN IF NOT EXISTS email_verified_at TEXT');
  await db.exec(PG_DDL);
  await db.exec(INDEX_DDL);
}
