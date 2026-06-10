import type Database from 'better-sqlite3';

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface ForeignKeyInfo {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

export const name = '0014_fix_scoring_runs_trademark_constraints';

export function up(db: Database.Database): void {
  const scoringRunsTableInfo = db.pragma('table_info(scoring_runs)') as ColumnInfo[];
  const hasUniqueRunId = scoringRunsTableInfo.some((col) => col.name === 'run_id');

  if (!hasUniqueRunId) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scoring_runs_run_id
      ON scoring_runs(run_id)
    `);
  }

  const fkList = db.pragma('foreign_key_list(trademark_results)') as ForeignKeyInfo[];
  const hasCandidateCascade = fkList.some(
    (fk) => fk.table === 'candidates' && fk.from === 'candidate_id' && fk.on_delete === 'CASCADE',
  );

  if (!hasCandidateCascade) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS trademark_results_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
        search_term TEXT NOT NULL,
        source TEXT NOT NULL,
        match_found INTEGER NOT NULL,
        match_details TEXT,
        raw_response TEXT,
        checked_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      )
    `);

    const existingRows = db.prepare('SELECT COUNT(*) as cnt FROM trademark_results').get() as {
      cnt: number;
    };
    if (existingRows.cnt > 0) {
      db.exec(`
        INSERT INTO trademark_results_new (id, candidate_id, search_term, source, match_found, match_details, raw_response, checked_at, expires_at)
        SELECT id, candidate_id, search_term, source, match_found, match_details, raw_response, checked_at, expires_at
        FROM trademark_results
      `);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trademark_new_candidate ON trademark_results_new(candidate_id, source)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trademark_new_term ON trademark_results_new(search_term, source)
    `);

    db.exec('DROP TABLE IF EXISTS trademark_results');
    db.exec('ALTER TABLE trademark_results_new RENAME TO trademark_results');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trademark_candidate ON trademark_results(candidate_id, source)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trademark_term ON trademark_results(search_term, source)
    `);
  }

  const cacheIndexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='provider_cache' AND name='idx_provider_cache_expires_at'",
    )
    .all() as { name: string }[];
  if (cacheIndexes.length === 0) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_provider_cache_expires_at
      ON provider_cache(expires_at)
    `);
  }
}
