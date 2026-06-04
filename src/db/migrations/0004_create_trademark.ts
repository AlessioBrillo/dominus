import type Database from 'better-sqlite3';
import { TRADEMARK_RESULTS_DDL, TRADEMARK_INDEX_DDL } from '../schema.js';

export const name = '0004_create_trademark';

export function up(db: Database.Database): void {
  db.exec(TRADEMARK_RESULTS_DDL);
  db.exec(TRADEMARK_INDEX_DDL);
}
