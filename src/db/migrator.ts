import type Database from 'better-sqlite3';
import { SCHEMA_MIGRATIONS_DDL } from './schema.js';
import * as m0001 from './migrations/0001_create_candidates.js';
import * as m0002 from './migrations/0002_create_scoring_runs.js';
import * as m0003 from './migrations/0003_create_portfolio.js';
import * as m0004 from './migrations/0004_create_trademark.js';
import * as m0005 from './migrations/0005_trademark_term_cache.js';
import * as m0006 from './migrations/0006_create_outcomes.js';
import * as m0007 from './migrations/0007_create_backtest_signals.js';
import * as m0008 from './migrations/0008_create_pipeline_runs.js';
import * as m0009 from './migrations/0009_create_renewal_alerts.js';
import * as m0010 from './migrations/0010_create_watchlist.js';
import * as m0011 from './migrations/0011_rename_weights_snapshot.js';
import * as m0012 from './migrations/0012_create_weight_snapshots.js';
import * as m0013 from './migrations/0013_create_provider_cache.js';

interface Migration {
  name: string;
  up: (db: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [
  m0001,
  m0002,
  m0003,
  m0004,
  m0005,
  m0006,
  m0007,
  m0008,
  m0009,
  m0010,
  m0011,
  m0012,
  m0013,
];

export function runMigrations(db: Database.Database): void {
  db.exec(SCHEMA_MIGRATIONS_DDL);

  const applied = new Set(
    (
      db.prepare('SELECT migration_name FROM schema_migrations').all() as {
        migration_name: string;
      }[]
    ).map((r) => r.migration_name),
  );

  const insert = db.prepare('INSERT INTO schema_migrations (migration_name) VALUES (?)');

  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.name)) {
      migration.up(db);
      insert.run(migration.name);
    }
  }
}
