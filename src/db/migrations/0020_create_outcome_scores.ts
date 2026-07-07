import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0020_create_outcome_scores';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outcome_scores (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      domain            TEXT    NOT NULL,
      outcome_type      TEXT    NOT NULL,
      recommended       INTEGER NOT NULL DEFAULT 0,
      weighted_score    REAL    NOT NULL DEFAULT 0,
      confidence        REAL    NOT NULL DEFAULT 0,
      expected_value    REAL    NOT NULL DEFAULT 0,
      actual_sale_price REAL,
      tld               TEXT    NOT NULL,
      scored_at         TEXT    NOT NULL,
      occurred_at       TEXT    NOT NULL,
      commercial_score  REAL    NOT NULL DEFAULT 0,
      market_score      REAL    NOT NULL DEFAULT 0,
      expiry_score      REAL    NOT NULL DEFAULT 0,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),

      UNIQUE(domain, occurred_at)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_outcome_scores_occurred
      ON outcome_scores(occurred_at DESC)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_outcome_scores_tld
      ON outcome_scores(tld)
  `);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(
    db,
    `
    CREATE TABLE IF NOT EXISTS outcome_scores (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      domain            TEXT    NOT NULL,
      outcome_type      TEXT    NOT NULL,
      recommended       INTEGER NOT NULL DEFAULT 0,
      weighted_score    REAL    NOT NULL DEFAULT 0,
      confidence        REAL    NOT NULL DEFAULT 0,
      expected_value    REAL    NOT NULL DEFAULT 0,
      actual_sale_price REAL,
      tld               TEXT    NOT NULL,
      scored_at         TEXT    NOT NULL,
      occurred_at       TEXT    NOT NULL,
      commercial_score  REAL    NOT NULL DEFAULT 0,
      market_score      REAL    NOT NULL DEFAULT 0,
      expiry_score      REAL    NOT NULL DEFAULT 0,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(domain, occurred_at)
    )
  `,
  );
  await execPg(
    db,
    `
    CREATE INDEX IF NOT EXISTS idx_outcome_scores_occurred
      ON outcome_scores(occurred_at DESC)
  `,
  );
  await execPg(
    db,
    `
    CREATE INDEX IF NOT EXISTS idx_outcome_scores_tld
      ON outcome_scores(tld)
  `,
  );
}
