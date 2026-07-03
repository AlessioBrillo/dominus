import type Database from 'better-sqlite3';

export const name = '0034_fix_listings_schema_divergence';

export function up(db: Database.Database): void {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='listings'`)
    .pluck()
    .all() as string[];
  if (tables.length === 0) return;

  const cols = db.prepare(`PRAGMA table_info(listings)`).all() as { name: string }[];
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has('list_price_eur')) {
    db.exec(`ALTER TABLE listings ADD COLUMN list_price_eur REAL`);
    db.exec(
      `UPDATE listings SET list_price_eur = price_eur WHERE list_price_eur IS NULL AND price_eur IS NOT NULL`,
    );
  }
  if (!colNames.has('external_id')) {
    db.exec(`ALTER TABLE listings ADD COLUMN external_id TEXT`);
  }
  if (!colNames.has('sold_at')) {
    db.exec(`ALTER TABLE listings ADD COLUMN sold_at TEXT`);
  }
  if (!colNames.has('sold_price_eur')) {
    db.exec(`ALTER TABLE listings ADD COLUMN sold_price_eur REAL`);
  }
}

export function down(): void {}
