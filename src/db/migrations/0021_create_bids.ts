import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0021_create_bids';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      venue TEXT NOT NULL,
      bid_amount_eur REAL NOT NULL,
      max_bid_eur REAL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','won','lost','cancelled','outbid')),
      won_price_eur REAL,
      expected_value_at_bid REAL,
      confidence_at_bid REAL,
      suggested_buy_max_at_bid REAL,
      trademark_clear_at_bid INTEGER,
      bid_placed_at TEXT NOT NULL DEFAULT (datetime('now')),
      auction_ends_at TEXT,
      resolved_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bids_domain ON bids(domain)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bids_status ON bids(status)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bids_placed_at ON bids(bid_placed_at)
  `);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(
    db,
    `
    CREATE TABLE IF NOT EXISTS bids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      venue TEXT NOT NULL,
      bid_amount_eur REAL NOT NULL,
      max_bid_eur REAL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','won','lost','cancelled','outbid')),
      won_price_eur REAL,
      expected_value_at_bid REAL,
      confidence_at_bid REAL,
      suggested_buy_max_at_bid REAL,
      trademark_clear_at_bid INTEGER,
      bid_placed_at TEXT NOT NULL DEFAULT (datetime('now')),
      auction_ends_at TEXT,
      resolved_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `,
  );
  await execPg(db, 'CREATE INDEX IF NOT EXISTS idx_bids_domain ON bids(domain)');
  await execPg(db, 'CREATE INDEX IF NOT EXISTS idx_bids_status ON bids(status)');
  await execPg(db, 'CREATE INDEX IF NOT EXISTS idx_bids_placed_at ON bids(bid_placed_at)');
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS bids');
}
