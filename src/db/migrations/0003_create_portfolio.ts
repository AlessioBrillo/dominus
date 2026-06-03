import type Database from 'better-sqlite3';
import { PORTFOLIO_ENTRIES_DDL } from '../schema.js';

export const name = '0003_create_portfolio';

export function up(db: Database.Database): void {
  db.exec(PORTFOLIO_ENTRIES_DDL);
}
