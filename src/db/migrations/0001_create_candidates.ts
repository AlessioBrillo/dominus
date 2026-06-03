import type Database from 'better-sqlite3';
import { CANDIDATES_DDL, CANDIDATES_INDEX_DDL } from '../schema.js';

export const name = '0001_create_candidates';

export function up(db: Database.Database): void {
  db.exec(CANDIDATES_DDL);
  db.exec(CANDIDATES_INDEX_DDL);
}
