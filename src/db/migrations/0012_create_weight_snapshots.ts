import type Database from 'better-sqlite3';
import {
  WEIGHT_SNAPSHOTS_DDL,
  WEIGHT_SNAPSHOTS_IDX_DDL,
  WEIGHT_SNAPSHOTS_SOURCE_IDX_DDL,
} from '../schema.js';

export const name = '0012_create_weight_snapshots';

export function up(db: Database.Database): void {
  db.exec(WEIGHT_SNAPSHOTS_DDL);
  db.exec(WEIGHT_SNAPSHOTS_IDX_DDL);
  db.exec(WEIGHT_SNAPSHOTS_SOURCE_IDX_DDL);
}
