import type Database from 'better-sqlite3';
import {
  RENEWAL_ALERTS_DDL,
  RENEWAL_ALERTS_DOMAIN_IDX_DDL,
  RENEWAL_ALERTS_UNACK_IDX_DDL,
  RENEWAL_ALERTS_UNIQUE_DDL,
} from '../schema.js';

export const name = '0009_create_renewal_alerts';

export function up(db: Database.Database): void {
  db.exec(RENEWAL_ALERTS_DDL);
  db.exec(RENEWAL_ALERTS_DOMAIN_IDX_DDL);
  db.exec(RENEWAL_ALERTS_UNACK_IDX_DDL);
  db.exec(RENEWAL_ALERTS_UNIQUE_DDL);
}
