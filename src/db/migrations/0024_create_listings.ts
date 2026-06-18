import type Database from 'better-sqlite3';

export const name = '0024_create_listings';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      domain          TEXT    NOT NULL,
      marketplace     TEXT    NOT NULL CHECK(marketplace IN ('dan','afternic','sedo','godaddy','manual')),
      listing_url     TEXT,
      price_eur       REAL    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','listed','offer_received','sold','expired','unlisted','pending','paused')),
      scoring_snapshot_json TEXT,
      listed_at       TEXT,
      expires_at      TEXT,
      notes           TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_domain_marketplace
      ON listings(domain, marketplace)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_listings_status
      ON listings(status)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_listings_marketplace
      ON listings(marketplace)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_offers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id      INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      amount_eur      REAL    NOT NULL,
      buyer           TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','accepted','declined','countered','expired','withdrawn')),
      received_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      responded_at    TEXT,
      notes           TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_listing_offers_listing
      ON listing_offers(listing_id)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_listing_offers_status
      ON listing_offers(status)
  `);
}

export function down(db: Database.Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_listing_offers_status`);
  db.exec(`DROP INDEX IF EXISTS idx_listing_offers_listing`);
  db.exec(`DROP TABLE IF EXISTS listing_offers`);
  db.exec(`DROP INDEX IF EXISTS idx_listings_marketplace`);
  db.exec(`DROP INDEX IF EXISTS idx_listings_status`);
  db.exec(`DROP INDEX IF EXISTS idx_listings_domain_marketplace`);
  db.exec(`DROP TABLE IF EXISTS listings`);
}
