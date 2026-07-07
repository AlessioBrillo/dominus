export {
  openDatabase,
  closeDatabase,
  acquireBulkWriteConnection,
  releaseBulkWriteConnection,
  createBulkWriteDatabaseProvider,
  getDatabase,
} from './database.js';
export { runMigrations } from './migrator.js';
export { PostgresAdapter } from './provider/postgres-adapter.js';
export type { DatabaseProvider, ExecResult, BackupResult } from './provider/interface.js';
export { SqliteProvider, MockDatabaseProvider } from './provider/index.js';

import type { Config } from '../config.js';
import type { DatabaseProvider } from './provider/interface.js';
import { SqliteProvider } from './provider/sqlite-adapter.js';
import { PostgresAdapter } from './provider/postgres-adapter.js';

/**
 * Create a DatabaseProvider based on config.
 *
 * - When DATABASE_URL is set: returns a PostgreSQL adapter (connections pooled).
 * - Otherwise: returns a SqliteProvider backed by DATABASE_PATH.
 *
 * This is the async factory used by the composition root. Tests should use
 * SqliteProvider.openInMemory() or MockDatabaseProvider directly.
 */
export async function createDatabaseProvider(config: Config): Promise<DatabaseProvider> {
  if (config.DATABASE_URL) {
    return PostgresAdapter.create(config.DATABASE_URL);
  }
  return SqliteProvider.create(config.DATABASE_PATH, {
    busyTimeout: config.DATABASE_BUSY_TIMEOUT,
  });
}

/**
 * Synchronous variant for use when DATABASE_URL is not set (SQLite only).
 * Throws if DATABASE_URL is configured — use createDatabaseProvider() instead.
 */
export function createSqliteProvider(config: Config): SqliteProvider {
  if (config.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is set but createSqliteProvider() was called. Use createDatabaseProvider() for async PG adapter.',
    );
  }
  return SqliteProvider.create(config.DATABASE_PATH, {
    busyTimeout: config.DATABASE_BUSY_TIMEOUT,
  });
}
export { CandidateRepository } from './repositories/candidate-repository.js';
export { ScoringRepository } from './repositories/scoring-repository.js';
export { PortfolioRepository } from './repositories/portfolio-repository.js';
export { TrademarkRepository } from './repositories/trademark-repository.js';
export { ProviderCacheRepository } from './repositories/provider-cache-repository.js';
export { OutcomeRepository } from './repositories/outcome-repository.js';
export { BacktestSignalsRepository } from './repositories/backtest-signals-repository.js';
export { PipelineRunsRepository } from './repositories/pipeline-runs-repository.js';
export { RenewalAlertRepository } from './repositories/renewal-alert-repository.js';
export { WatchlistRepository } from './repositories/watchlist-repository.js';
export { WeightSnapshotRepository } from './repositories/weight-snapshot-repository.js';
export { SchedulerJobRepository } from './repositories/scheduler-job-repository.js';
export { MetricsRepository } from './repositories/metrics-repository.js';
export { JobQueueRepository } from './repositories/job-queue-repository.js';
export { ListingRepository } from './repositories/listing-repository.js';
export { AutoListingRepository } from './repositories/auto-listing-repository.js';
export { AcquisitionRepository } from './repositories/acquisition-repository.js';
export { ApiKeyRepository } from './repositories/api-key-repository.js';
export type {
  StageMetricRow,
  MetricAggregate,
  MetricsHistory,
} from './repositories/metrics-repository.js';
export type {
  PipelineRun,
  PipelineRunInputs,
  PipelineRunResults,
  InsertPipelineRunInput,
  CompletePipelineRunInput,
  ListPipelineRunsOptions,
} from './repositories/pipeline-runs-repository.js';
