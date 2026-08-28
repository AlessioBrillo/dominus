// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import type Database from 'better-sqlite3';
import type { TrademarkRepository } from '../../db/repositories/trademark-repository.js';
import type { PipelineRunsRepository } from '../../db/repositories/pipeline-runs-repository.js';
import type { ProviderCacheRepository } from '../../db/repositories/provider-cache-repository.js';
import type { CandidateRepository } from '../../db/repositories/candidate-repository.js';
import type { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import type { UsageRepository } from '../../db/repositories/usage-repository.js';
import type { BackupService } from '../../scheduler/backup-service.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { rollbackMigration } from '../../db/migrator.js';
import { RESCORE_RUN_ID_PREFIX } from '../../portfolio/portfolio-rescore-service.js';

export interface MaintenanceCommandDeps {
  db: Database.Database | null;
  trademarkRepo: TrademarkRepository;
  providerCacheRepo?: ProviderCacheRepository | undefined;
  runsRepo: PipelineRunsRepository;
  candidateRepo: CandidateRepository;
  scoringRepo?: ScoringRepository | undefined;
  usageRepo?: UsageRepository | undefined;
  backupService?: BackupService | undefined;
}

function assertDb(db: Database.Database | null, cmd: string): Database.Database {
  if (!db) {
    process.stderr.write(
      `Error: 'dominus ${cmd}' requires a SQLite database. Not available in PostgreSQL mode.\n`,
    );
    process.exit(1);
  }
  return db;
}

export function registerMaintenanceCommand(program: Command, deps: MaintenanceCommandDeps): void {
  const rawDb = assertDb(deps.db, 'maintenance');
  const maintenance = program
    .command('maintenance')
    .description('Prune ephemeral data, backup, and vacuum the database');

  maintenance
    .command('backup')
    .description('Create a safe, consistent SQLite backup via VACUUM INTO')
    .argument(
      '[path]',
      'Output path for the backup file (default: ./data/backup/dominus-<YYYY-MM-DD>.db)',
    )
    .option('--list', 'List existing backups (ignores [path] argument)')
    .action((backupPath?: string, options?: { list?: boolean }) => {
      if (options?.list && deps.backupService) {
        const backups = deps.backupService.list();
        if (backups.length === 0) {
          process.stdout.write('No backups found.\n');
          return;
        }
        process.stdout.write('Backups:\n');
        for (const b of backups) {
          const sizeKb = (b.sizeBytes / 1024).toFixed(1);
          process.stdout.write(`  ${b.path}  (${sizeKb}KB, ${b.createdAt.toISOString()})\n`);
        }
        return;
      }

      const path =
        backupPath ?? `./data/backup/dominus-${new Date().toISOString().slice(0, 10)}.db`;
      const absPath = resolve(process.cwd(), path);
      mkdirSync(dirname(absPath), { recursive: true });

      rawDb.pragma('wal_checkpoint(TRUNCATE)');
      if (absPath.includes("'")) {
        process.stderr.write('Error: backup path must not contain single quotes\n');
        process.exit(1);
      }
      rawDb.exec(`VACUUM INTO '${absPath.replace(/'/g, "''")}'`);

      process.stdout.write(`Backup written to ${absPath}\n`);
    });

  maintenance
    .command('vacuum')
    .description('Run integrity_check, WAL checkpoint, and VACUUM to reclaim space')
    .action(() => {
      process.stdout.write('Running integrity_check...\n');
      const integrity = rawDb.pragma('integrity_check') as unknown as string;
      if (integrity !== 'ok') {
        process.stderr.write(`INTEGRITY CHECK FAILED: ${integrity}\n`);
        process.exit(1);
      }
      process.stdout.write('Integrity check passed.\n');

      process.stdout.write('Checkpointing WAL...\n');
      rawDb.pragma('wal_checkpoint(TRUNCATE)');

      process.stdout.write('Running VACUUM...\n');
      rawDb.exec('VACUUM');

      process.stdout.write('Database vacuumed successfully.\n');
    });

  maintenance
    .command('prune')
    .description(
      'Delete expired rows from TM cache, provider cache, pipeline_runs history, and rescore candidates',
    )
    .option('--cache-only', 'Prune only the trademark_results cache')
    .option('--provider-cache-only', 'Prune only the provider cache')
    .option('--runs-only', 'Prune only the pipeline_runs history')
    .option('--rescore-only', 'Prune only synthetic portfolio_rescore candidates')
    .option('--usage-only', 'Prune only the usage_records meter history')
    .option('--before <days>', 'Prune rows older than N days (default: 90)', parseInt)
    .option('--dry-run', 'Print counts of rows that would be removed without writing')
    .action(
      async (options: {
        cacheOnly?: boolean;
        providerCacheOnly?: boolean;
        runsOnly?: boolean;
        rescoreOnly?: boolean;
        usageOnly?: boolean;
        before?: number;
        dryRun?: boolean;
      }) => {
        if (options.cacheOnly === true && options.providerCacheOnly === true) {
          process.stderr.write(
            'Error: --cache-only and --provider-cache-only are mutually exclusive\n',
          );
          process.exit(1);
        }
        if (options.cacheOnly === true && options.runsOnly === true) {
          process.stderr.write('Error: --cache-only and --runs-only are mutually exclusive\n');
          process.exit(1);
        }
        if (
          (options.cacheOnly === true || options.runsOnly === true) &&
          options.rescoreOnly === true
        ) {
          process.stderr.write('Error: --rescore-only is mutually exclusive with other flags\n');
          process.exit(1);
        }
        if (
          options.usageOnly === true &&
          (options.cacheOnly === true ||
            options.providerCacheOnly === true ||
            options.runsOnly === true ||
            options.rescoreOnly === true)
        ) {
          process.stderr.write('Error: --usage-only and other flags are mutually exclusive\n');
          process.exit(1);
        }

        const usageOnly = options.usageOnly === true;
        const pruneCache =
          usageOnly === false && options.runsOnly !== true && options.rescoreOnly !== true;
        const pruneProviderCache =
          usageOnly === false &&
          (options.providerCacheOnly === true ||
            (options.runsOnly !== true &&
              options.cacheOnly !== true &&
              options.rescoreOnly !== true));
        const pruneRuns =
          usageOnly === false && options.cacheOnly !== true && options.rescoreOnly !== true;
        const pruneRescore = usageOnly === false && options.rescoreOnly === true;
        const retentionDays = options.before ?? 90;

        if (usageOnly && deps.usageRepo) {
          const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
          if (options.dryRun === true) {
            const expired = await deps.usageRepo.countUsageOlderThan(cutoff);
            process.stdout.write(
              `Would prune ${expired} usage_records row(s) started before ${cutoff}.\n`,
            );
          } else {
            const removed = await deps.usageRepo.deleteUsageOlderThan(cutoff);
            process.stdout.write(
              `Pruned ${removed} usage_records row(s) started before ${cutoff}.\n`,
            );
          }
        }

        if (pruneProviderCache && deps.providerCacheRepo) {
          const before = await deps.providerCacheRepo.count();
          if (options.dryRun === true) {
            process.stdout.write(`Would prune ${before} provider_cache row(s).\n`);
          } else {
            const removed = await deps.providerCacheRepo.pruneExpired();
            const after = await deps.providerCacheRepo.count();
            process.stdout.write(`Pruned ${removed} provider_cache row(s); ${after} remain.\n`);
          }
        }

        if (pruneCache) {
          const before = await deps.trademarkRepo.count();
          if (options.dryRun === true) {
            process.stdout.write(`Would prune ${before} trademark_results row(s).\n`);
          } else {
            const removed = await deps.trademarkRepo.pruneExpired();
            const after = await deps.trademarkRepo.count();
            process.stdout.write(`Pruned ${removed} trademark_results row(s); ${after} remain.\n`);
          }
        }

        if (pruneRuns) {
          if (options.before !== undefined) {
            const cutoff = new Date(
              Date.now() - options.before * 24 * 60 * 60 * 1000,
            ).toISOString();
            const before = await deps.runsRepo.count();
            if (options.dryRun === true) {
              const expired = await deps.runsRepo.countBefore(cutoff);
              process.stdout.write(
                `Would prune ${expired} pipeline_runs row(s) started before ${cutoff} (${before} total rows).\n`,
              );
            } else {
              const removed = await deps.runsRepo.pruneBefore(cutoff);
              const after = await deps.runsRepo.count();
              process.stdout.write(
                `Pruned ${removed} pipeline_runs row(s) started before ${cutoff}; ${after} remain.\n`,
              );
            }
          } else {
            const before = await deps.runsRepo.count();
            if (options.dryRun === true) {
              process.stdout.write(
                `Would prune pipeline_runs rows whose retained_until < now (${before} total rows).\n`,
              );
            } else {
              const removed = await deps.runsRepo.prune();
              const after = await deps.runsRepo.count();
              process.stdout.write(`Pruned ${removed} pipeline_runs row(s); ${after} remain.\n`);
            }
          }
        }

        if (pruneRescore) {
          const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
          const prefix = `${RESCORE_RUN_ID_PREFIX}%`;

          // Prune orphaned scoring_runs first (run_id LIKE 'portfolio-rescore-%').
          if (deps.scoringRepo) {
            const scoringBefore = await deps.scoringRepo.pruneByRunIdPrefix(prefix, cutoff);
            process.stdout.write(
              `Pruned ${scoringBefore} portfolio_rescore scoring_runs row(s).\n`,
            );
          }

          // Then prune candidates that are no longer referenced.
          const before = await deps.candidateRepo.countRescoreCandidates(cutoff);
          if (options.dryRun === true) {
            process.stdout.write(
              `Would prune ${before} portfolio_rescore candidate(s) created before ${cutoff}.\n`,
            );
          } else {
            const removed = await deps.candidateRepo.pruneRescoreCandidates(cutoff);
            const after = await deps.candidateRepo.countRescoreCandidates(cutoff);
            process.stdout.write(
              `Pruned ${removed} portfolio_rescore candidate(s) created before ${cutoff}; ${after} remain.\n`,
            );
          }
        }
      },
    );

  // Migration management subcommands
  const migrate = maintenance
    .command('migrate')
    .description('Migration management (rollback, status)');

  migrate
    .command('rollback <migrationName>')
    .description('Rollback the last applied migration (must be LIFO order)')
    .option('--force', 'Skip confirmation prompt (required for automation)')
    .option('--dry-run', 'Show what would be rolled back without executing')
    .action(async (migrationName: string, options: { force?: boolean; dryRun?: boolean }) => {
      const rawDb = assertDb(deps.db, 'maintenance migrate rollback');
      const provider = new SqliteProvider(rawDb, 30000, true); // externalLifecycle = true

      try {
        // Verify migration exists and is the last applied
        const { readAppliedMigrations } = await import('../../db/migration-manifest.js');
        const { getMigrations } = await import('../../db/migrations/registry.js');

        const applied = await readAppliedMigrations(provider);
        if (applied.length === 0) {
          process.stderr.write('Error: No migrations applied — nothing to rollback\n');
          process.exit(1);
        }

        const lastApplied = applied[applied.length - 1];
        if (lastApplied !== migrationName) {
          process.stderr.write(
            `Error: Cannot rollback '${migrationName}' — must rollback in reverse order. ` +
              `Last applied migration is '${lastApplied}'.\n`,
          );
          process.exit(1);
        }

        const migrations = getMigrations();
        const migration = migrations.find((m) => m.name === migrationName);
        if (!migration) {
          process.stderr.write(`Error: Migration '${migrationName}' not found\n`);
          process.exit(1);
        }

        if (!migration.down && !migration.backwardCompatible) {
          process.stderr.write(
            `Error: Migration '${migrationName}' has no down() function and is not marked backwardCompatible. ` +
              `Cannot rollback safely.\n`,
          );
          process.exit(1);
        }

        if (options.dryRun) {
          process.stdout.write(`Would rollback migration: ${migrationName}\n`);
          process.stdout.write(`  Last applied: ${lastApplied}\n`);
          process.stdout.write(`  Has down(): ${!!migration.down}\n`);
          process.stdout.write(`  backwardCompatible: ${migration.backwardCompatible === true}\n`);
          return;
        }

        if (!options.force) {
          process.stdout.write(
            `WARNING: This will rollback migration '${migrationName}' and may remove data.\n` +
              `Run with --force to confirm.\n`,
          );
          process.exit(1);
        }

        process.stdout.write(`Rolling back migration: ${migrationName}...\n`);
        await rollbackMigration(provider, migrationName);
        process.stdout.write(`Migration '${migrationName}' rolled back successfully.\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      } finally {
        await provider.close();
      }
    });

  migrate
    .command('status')
    .description('Show applied migrations and pending migrations')
    .action(async () => {
      const rawDb = assertDb(deps.db, 'maintenance migrate status');
      const provider = new SqliteProvider(rawDb, 30000, true);

      try {
        const { readAppliedMigrations } = await import('../../db/migration-manifest.js');
        const { getMigrationNames } = await import('../../db/migrations/registry.js');

        const applied = await readAppliedMigrations(provider);
        const allMigrations = getMigrationNames();

        process.stdout.write('Applied migrations:\n');
        if (applied.length === 0) {
          process.stdout.write('  (none)\n');
        } else {
          for (const name of applied) {
            process.stdout.write(`  ${name}\n`);
          }
        }

        const pending = allMigrations.filter((m) => !applied.includes(m));
        process.stdout.write('\nPending migrations:\n');
        if (pending.length === 0) {
          process.stdout.write('  (none — fully up to date)\n');
        } else {
          for (const name of pending) {
            process.stdout.write(`  ${name}\n`);
          }
        }
      } finally {
        await provider.close();
      }
    });
}
