import type Database from 'better-sqlite3';
import { SCORING_RUNS_DDL, SCORING_RUNS_INDEX_DDL } from '../schema.js';

export const name = '0002_create_scoring_runs';

export function up(db: Database.Database): void {
  db.exec(SCORING_RUNS_DDL);
  db.exec(SCORING_RUNS_INDEX_DDL);
}
