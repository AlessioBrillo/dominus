import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0038_add_portfolio_verification_timestamps';

export function up(db: Database.Database): void {
  // last_rdap_verified_at tracks the most recent RDAP check on this domain.
  // last_whois_renewal_date stores the expiry date returned by the most
  // recent WHOIS/RDAP lookup, which may differ from the operator-entered
  // renewal_date (registrar may have auto-renewed, transferred, etc.).
  const existing = db
    .prepare(
      "SELECT name FROM pragma_table_info('portfolio_entries') WHERE name = 'last_rdap_verified_at'",
    )
    .get();
  if (!existing) {
    db.exec(`ALTER TABLE portfolio_entries ADD COLUMN last_rdap_verified_at TEXT`);
  }

  const existingWhois = db
    .prepare(
      "SELECT name FROM pragma_table_info('portfolio_entries') WHERE name = 'last_whois_renewal_date'",
    )
    .get();
  if (!existingWhois) {
    db.exec(`ALTER TABLE portfolio_entries ADD COLUMN last_whois_renewal_date TEXT`);
  }

  // Ensure domain column has an index for efficient portfolio healthcheck scans
  // (the existing index may be partial or missing in some deployment histories).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_portfolio_entries_rdap_pending
      ON portfolio_entries(last_rdap_verified_at)
      WHERE last_rdap_verified_at IS NULL
  `);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  const colExists = await db.queryOne<{ exists: number }>(
    `SELECT 1 as exists FROM information_schema.columns WHERE table_name = 'portfolio_entries' AND column_name = 'last_rdap_verified_at'`,
  );
  if (!colExists?.exists) {
    await db.exec(`ALTER TABLE portfolio_entries ADD COLUMN last_rdap_verified_at TIMESTAMP`);
  }

  const whoisColExists = await db.queryOne<{ exists: number }>(
    `SELECT 1 as exists FROM information_schema.columns WHERE table_name = 'portfolio_entries' AND column_name = 'last_whois_renewal_date'`,
  );
  if (!whoisColExists?.exists) {
    await db.exec(`ALTER TABLE portfolio_entries ADD COLUMN last_whois_renewal_date TIMESTAMP`);
  }

  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_portfolio_entries_rdap_pending ON portfolio_entries(last_rdap_verified_at) WHERE last_rdap_verified_at IS NULL`,
  );
}

export function down(db: Database.Database): void {
  // SQLite does not support DROP COLUMN in older versions.
  // We leave the columns in place; a full recreate is needed to remove them.
  db.exec('DROP INDEX IF EXISTS idx_portfolio_entries_rdap_pending');
}
