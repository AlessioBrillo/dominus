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
import * as m0014 from './migrations/0014_create_scheduler_jobs.js';
import * as m0015 from './migrations/0015_fix_scoring_runs_trademark_constraints.js';
import * as m0016 from './migrations/0016_add_backtest_costs.js';
import * as m0017 from './migrations/0017_add_pipeline_run_index.js';
import * as m0018 from './migrations/0018_create_pipeline_metrics.js';
import * as m0019 from './migrations/0019_add_scoring_run_recommended.js';
import * as m0020 from './migrations/0020_create_outcome_scores.js';
import * as m0021 from './migrations/0021_create_bids.js';
import * as m0022 from './migrations/0022_create_job_queue.js';
import * as m0023 from './migrations/0023_add_outcome_costs.js';
import * as m0024 from './migrations/0024_create_listings.js';
import * as m0025 from './migrations/0025_create_events_and_onboarding.js';
import * as m0026 from './migrations/0026_create_public_scores.js';
import * as m0027 from './migrations/0027_create_wayback_cache.js';
import * as m0028 from './migrations/0028_create_auto_listings.js';
import * as m0029 from './migrations/0029_add_tenant_id.js';
import * as m0030 from './migrations/0030_enable_rls.js';
import * as m0031 from './migrations/0031_create_auth_rate_limits.js';
import * as m0032 from './migrations/0032_create_pipeline_locks.js';

interface Migration {
  name: string;
  up: (db: Database.Database) => void;
  /** Optional rollback function. Must reverse the up() DDL exactly.
   *  Only supported for forward-only environments (single-user).
   *  Not available in shared/HA deployments — use backup-restore instead. */
  down?: (db: Database.Database) => void;
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
  m0014,
  m0015,
  m0016,
  m0017,
  m0018,
  m0019,
  m0020,
  m0021,
  m0022,
  m0023,
  m0024,
  m0025,
  m0026,
  m0027,
  m0028,
  m0029,
  m0030,
  m0031,
  m0032,
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
