import type { DatabaseProvider } from './provider/interface.js';

/**
 * Convert SQLite CREATE TABLE/INDEX DDL to PostgreSQL-compatible DDL.
 * Handles the common subset of DDL used in DOMINUS migrations.
 *
 * Conversions applied:
 *   - INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL PRIMARY KEY
 *   - INTEGER PRIMARY KEY → SERIAL PRIMARY KEY
 *   - TEXT NOT NULL DEFAULT (datetime('now')) → TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
 *   - TEXT DEFAULT (datetime('now')) → TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 *   - TEXT (when used as date/timestamp column name) → TIMESTAMP
 *   - INTEGER NOT NULL DEFAULT 0/1 → INTEGER NOT NULL DEFAULT 0/1 (pass-through)
 *   - REAL → REAL (pass-through)
 *   - BLOB → BYTEA
 *
 * @param sql SQLite DDL
 * @returns PostgreSQL-compatible DDL
 */
export function toPgDdl(sql: string): string {
  return (
    sql
      // PK autoincrement
      .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'SERIAL PRIMARY KEY')
      // Standalone INTEGER PRIMARY KEY (without AUTOINCREMENT)
      .replace(/\bINTEGER\s+PRIMARY\s+KEY\b/gi, 'SERIAL PRIMARY KEY')
      // TEXT datetime defaults
      .replace(
        /TEXT\s+NOT\s+NULL\s+DEFAULT\s+\(datetime\('now'\)\)/gi,
        'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP',
      )
      .replace(/TEXT\s+DEFAULT\s+\(datetime\('now'\)\)/gi, 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP')
      // TEXT used as date/time column (by naming convention _at or _date)
      .replace(
        /\b(TEXT)\b(?=\s+(NOT\s+)?NULL\s+(DEFAULT\s+)?)/gi,
        (match, _p1, _p2, _p3, offset, source) => {
          const before = source.slice(Math.max(0, offset - 20), offset).toLowerCase();
          if (before.includes('_at') || before.includes('_date') || before.includes('_time')) {
            return 'TIMESTAMP';
          }
          return match;
        },
      )
      // BLOB
      .replace(/\bBLOB\b/gi, 'BYTEA')
      // sqlite sequence cleanup (not PG compatible)
      .replace(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+sqlite_sequence\b.*?;/gi, '')
      .trim()
  );
}

/**
 * Execute a SQLite DDL string as PostgreSQL via a DatabaseProvider.
 * Applies toPgDdl conversion automatically.
 */
export async function execPg(db: DatabaseProvider, sql: string, params?: unknown[]): Promise<void> {
  const pgSql = toPgDdl(sql);
  await db.exec(pgSql, params);
}
