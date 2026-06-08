import type Database from 'better-sqlite3';
import {
  WATCHLIST_ENTRIES_DDL,
  WATCHLIST_CHECKED_AT_IDX_DDL,
  WATCHLIST_NOTIFIED_IDX_DDL,
} from '../schema.js';

export const name = '0010_create_watchlist';

export function up(db: Database.Database): void {
  db.exec(WATCHLIST_ENTRIES_DDL);
  db.exec(WATCHLIST_CHECKED_AT_IDX_DDL);
  db.exec(WATCHLIST_NOTIFIED_IDX_DDL);
}
