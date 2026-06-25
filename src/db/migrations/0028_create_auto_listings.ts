import type Database from 'better-sqlite3';

export const name = '0028_create_auto_listings';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_listings (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      domain            TEXT    NOT NULL,
      portfolio_entry_id INTEGER,
      listing_id        INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      trigger_source    TEXT    NOT NULL CHECK(trigger_source IN ('acquisition','purchase','pipeline_run','manual')),
      pipeline_run_id   TEXT,
      score_snapshot_json TEXT,
      auto_listed_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      status            TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','cancelled'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_auto_listings_domain
      ON auto_listings(domain)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_auto_listings_listing
      ON auto_listings(listing_id)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_auto_listings_source
      ON auto_listings(trigger_source)
  `);
}

export function down(db: Database.Database): void {
  db.exec('DROP INDEX IF EXISTS idx_auto_listings_source');
  db.exec('DROP INDEX IF EXISTS idx_auto_listings_listing');
  db.exec('DROP INDEX IF EXISTS idx_auto_listings_domain');
  db.exec('DROP TABLE IF EXISTS auto_listings');
}
