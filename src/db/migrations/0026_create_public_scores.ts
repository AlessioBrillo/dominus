import type Database from 'better-sqlite3';

export const name = '0026_create_public_scores';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS public_scores (
      slug           TEXT    NOT NULL PRIMARY KEY,
      domain         TEXT    NOT NULL,
      score_json     TEXT    NOT NULL,
      trademark_json TEXT,
      view_count     INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_public_scores_domain
      ON public_scores(domain)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_public_scores_created
      ON public_scores(created_at DESC)
  `);
}

export function down(db: Database.Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_public_scores_created`);
  db.exec(`DROP INDEX IF EXISTS idx_public_scores_domain`);
  db.exec(`DROP TABLE IF EXISTS public_scores`);
}
