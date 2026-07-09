import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0037_create_tld_renewal_costs';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tld_renewal_costs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tld               TEXT    NOT NULL UNIQUE,
      renewal_cost_eur  REAL    NOT NULL CHECK(renewal_cost_eur > 0),
      registrar         TEXT,
      updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tld_renewal_costs_tld
      ON tld_renewal_costs(tld)
  `);

  // Seed common TLDs with known renewal costs (EUR, approximate market rates).
  // Operators can update via direct SQL or a future CLI command. These values
  // are sourced from public registrar pricing as of Q2 2026 — they are
  // deliberately conservative (high side) so NPV projections err toward drop.
  const seed: Array<[string, number, string]> = [
    ['.com', 10.5, 'default'],
    ['.net', 12.0, 'default'],
    ['.org', 11.0, 'default'],
    ['.io', 35.0, 'default'],
    ['.ai', 100.0, 'default'],
    ['.co', 28.0, 'default'],
    ['.dev', 12.0, 'default'],
    ['.app', 12.0, 'default'],
    ['.me', 20.0, 'default'],
    ['.xyz', 10.0, 'default'],
    ['.de', 9.0, 'default'],
    ['.uk', 8.0, 'default'],
    ['.eu', 8.0, 'default'],
    ['.it', 9.0, 'default'],
    ['.fr', 9.0, 'default'],
    ['.es', 8.0, 'default'],
    ['.nl', 9.0, 'default'],
    ['.us', 10.0, 'default'],
    ['.info', 12.0, 'default'],
    ['.biz', 12.0, 'default'],
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO tld_renewal_costs (tld, renewal_cost_eur, registrar)
    VALUES (?, ?, ?)
  `);
  for (const [tld, cost, registrar] of seed) {
    insert.run(tld, cost, registrar);
  }
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(
    db,
    `
    CREATE TABLE IF NOT EXISTS tld_renewal_costs (
      id                SERIAL PRIMARY KEY,
      tld               TEXT    NOT NULL UNIQUE,
      renewal_cost_eur  NUMERIC NOT NULL CHECK(renewal_cost_eur > 0),
      registrar         TEXT,
      updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `,
  );

  await execPg(
    db,
    'CREATE INDEX IF NOT EXISTS idx_tld_renewal_costs_tld ON tld_renewal_costs(tld)',
  );

  // Seed values match SQLite seed above.
  const seed: Array<[string, number, string]> = [
    ['.com', 10.5, 'default'],
    ['.net', 12.0, 'default'],
    ['.org', 11.0, 'default'],
    ['.io', 35.0, 'default'],
    ['.ai', 100.0, 'default'],
    ['.co', 28.0, 'default'],
    ['.dev', 12.0, 'default'],
    ['.app', 12.0, 'default'],
    ['.me', 20.0, 'default'],
    ['.xyz', 10.0, 'default'],
    ['.de', 9.0, 'default'],
    ['.uk', 8.0, 'default'],
    ['.eu', 8.0, 'default'],
    ['.it', 9.0, 'default'],
    ['.fr', 9.0, 'default'],
    ['.es', 8.0, 'default'],
    ['.nl', 9.0, 'default'],
    ['.us', 10.0, 'default'],
    ['.info', 12.0, 'default'],
    ['.biz', 12.0, 'default'],
  ];

  for (const [tld, cost, registrar] of seed) {
    await db.exec(
      'INSERT INTO tld_renewal_costs (tld, renewal_cost_eur, registrar) VALUES ($1, $2, $3) ON CONFLICT (tld) DO NOTHING',
      [tld, cost, registrar],
    );
  }
}

export function down(db: Database.Database): void {
  db.exec('DROP INDEX IF EXISTS idx_tld_renewal_costs_tld');
  db.exec('DROP TABLE IF EXISTS tld_renewal_costs');
}
