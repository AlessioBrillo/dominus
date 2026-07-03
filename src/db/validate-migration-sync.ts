import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PG_MIGRATIONS } from './provider/pg-migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS_DIR = join(__dirname, 'migrations');

/** Expected set of migration names shared between SQLite and PostgreSQL. */
const EXPECTED_MIGRATIONS = [
  '0001_create_candidates',
  '0002_create_scoring_runs',
  '0003_create_portfolio',
  '0004_create_trademark',
  '0005_trademark_term_cache',
  '0006_create_outcomes',
  '0007_create_backtest_signals',
  '0008_create_pipeline_runs',
  '0009_create_renewal_alerts',
  '0010_create_watchlist',
  '0011_rename_weights_snapshot',
  '0012_create_weight_snapshots',
  '0013_create_provider_cache',
  '0014_create_scheduler_jobs',
  '0015_fix_scoring_runs_trademark_constraints',
  '0016_add_backtest_costs',
  '0017_add_pipeline_run_index',
  '0018_create_pipeline_metrics',
  '0019_add_scoring_run_recommended',
  '0020_create_outcome_scores',
  '0021_create_bids',
  '0022_create_job_queue',
  '0023_add_outcome_costs',
  '0024_create_listings',
  '0025_create_events_and_onboarding',
  '0026_create_public_scores',
  '0027_create_wayback_cache',
  '0028_create_auto_listings',
  '0029_add_tenant_id',
  '0030_enable_rls',
  '0031_create_auth_rate_limits',
  '0032_create_pipeline_locks',
  '0033_create_api_keys',
  '0034_fix_listings_schema_divergence',
  '0035_fix_wayback_cache_divergence',
];

export function validateMigrationSync(): string[] {
  const errors: string[] = [];

  // Check SQLite migrations directory
  let sqliteNames: string[];
  try {
    sqliteNames = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.ts') && /^\d{4}/.test(f))
      .map((f) => f.replace(/\.ts$/, ''))
      .sort();
  } catch (err) {
    return [`Cannot read SQLite migrations directory: ${MIGRATIONS_DIR} — ${err}`];
  }

  // Check PG_MIGRATIONS module
  const pgNames = PG_MIGRATIONS.map((m) => m.name).sort();

  // Cross-reference
  const seen = new Set<string>();

  for (const name of sqliteNames) {
    seen.add(name);
    if (!EXPECTED_MIGRATIONS.includes(name)) {
      errors.push(
        `Unexpected SQLite migration '${name}' not in EXPECTED_MIGRATIONS. ` +
          'Add it to EXPECTED_MIGRATIONS and ensure a corresponding PG_MIGRATIONS entry exists.',
      );
    }
    if (!pgNames.includes(name)) {
      errors.push(`SQLite migration '${name}' is missing from PG_MIGRATIONS in pg-migrations.ts`);
    }
  }

  for (const name of pgNames) {
    if (!sqliteNames.includes(name)) {
      errors.push(
        `PG_MIGRATIONS entry '${name}' has no corresponding SQLite migration file in migrations/`,
      );
    }
  }

  for (const name of EXPECTED_MIGRATIONS) {
    if (!seen.has(name)) {
      errors.push(
        `Expected migration '${name}' is missing from both SQLite migrations/ and PG_MIGRATIONS`,
      );
    }
  }

  return errors;
}

// CLI mode
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('validate-migration-sync.ts') ?? false;
if (isMain) {
  const errors = validateMigrationSync();
  if (errors.length === 0) {
    console.log(
      `✓ SQLite and PostgreSQL migrations are in sync (${EXPECTED_MIGRATIONS.length} migrations)`,
    );
    process.exit(0);
  }

  console.error(`Migration drift detected (${errors.length} issue(s)):\n`);
  for (const err of errors) {
    console.error(`  • ${err}`);
  }
  process.exit(1);
}
