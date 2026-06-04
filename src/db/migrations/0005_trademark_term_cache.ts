import type Database from 'better-sqlite3';
import { TRADEMARK_TERM_INDEX_DDL } from '../schema.js';

/**
 * Make trademark_results.candidate_id nullable and add a (search_term, source)
 * index so the caching layer can look up results by term rather than by candidate
 * DB id.
 *
 * Background: the trademark gate runs inside the pipeline orchestrator, before
 * PipelineRunService persists candidates to the database. At gate time there is
 * no candidate_id to reference. Caching must therefore key on the search term.
 * The candidate_id column is kept for future use (post-run linking) but is now
 * nullable so term-only cache rows are valid.
 *
 * Safe to run on an existing database: trademark_results was never populated at
 * runtime (both providers were stubs); the table is always empty before this
 * migration.
 */

export const name = '0005_trademark_term_cache';

export function up(db: Database.Database): void {
  // SQLite does not support ALTER COLUMN, so we recreate the table.
  // The table is always empty at this point (providers were stubs).
  db.exec(`DROP TABLE IF EXISTS trademark_results`);
  db.exec(`
    CREATE TABLE trademark_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER REFERENCES candidates(id),
      search_term TEXT NOT NULL,
      source TEXT NOT NULL,
      match_found INTEGER NOT NULL,
      match_details TEXT,
      raw_response TEXT,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trademark_candidate ON trademark_results(candidate_id, source)`);
  db.exec(TRADEMARK_TERM_INDEX_DDL);
}
