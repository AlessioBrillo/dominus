import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import type Database from 'better-sqlite3';
import type { TrademarkRepository } from '../../db/repositories/trademark-repository.js';
import type { PipelineRunsRepository } from '../../db/repositories/pipeline-runs-repository.js';

export interface MaintenanceCommandDeps {
  db: Database.Database;
  trademarkRepo: TrademarkRepository;
  runsRepo: PipelineRunsRepository;
}

export function registerMaintenanceCommand(program: Command, deps: MaintenanceCommandDeps): void {
  const maintenance = program.command('maintenance').description('Prune ephemeral data, backup the database');

  maintenance
    .command('backup')
    .description('Create a safe, consistent SQLite backup via VACUUM INTO')
    .argument('[path]', 'Output path for the backup file (default: ./data/dominus-<YYYY-MM-DD>.db)')
    .action((backupPath?: string) => {
      const path = backupPath ?? `./data/dominus-${new Date().toISOString().slice(0, 10)}.db`;
      const absPath = resolve(process.cwd(), path);
      mkdirSync(dirname(absPath), { recursive: true });

      // Flush the WAL so VACUUM INTO gets a fully consistent snapshot.
      // In single-user mode there is no concurrent writer, so checkpoint
      // is guaranteed to complete immediately.
      deps.db.pragma('wal_checkpoint(TRUNCATE)');
      // Parameterise the path via a pragma-safe approach: SQLite VACUUM
      // INTO does not accept bound parameters, so we escape single quotes.
      if (absPath.includes("'")) {
        process.stderr.write('Error: backup path must not contain single quotes\n');
        process.exit(1);
      }
      deps.db.exec(`VACUUM INTO '${absPath}'`);

      const size = ((): string => {
        try {
          const { size: s } = (deps.db.prepare("SELECT size FROM pragma_database_size").get() ?? {}) as { size?: number };
          return s !== undefined ? `${(s / 1024 / 1024).toFixed(1)} MB` : 'unknown';
        } catch {
          return 'unknown';
        }
      })();
      process.stdout.write(`Backup written to ${absPath} (database size: ${size})\n`);
    });

  maintenance
    .command('prune')
    .description('Delete expired rows from the TM cache and/or the pipeline_runs history')
    .option('--cache-only', 'Prune only the trademark_results cache')
    .option('--runs-only', 'Prune only the pipeline_runs history')
    .option('--before <days>', 'Prune pipeline_runs older than N days (overrides retained_until)', parseInt)
    .option('--dry-run', 'Print counts of rows that would be removed without writing')
    .action((options: { cacheOnly?: boolean; runsOnly?: boolean; before?: number; dryRun?: boolean }) => {
      const pruneCache = options.runsOnly !== true;
      const pruneRuns = options.cacheOnly !== true;
      if (options.cacheOnly === true && options.runsOnly === true) {
        process.stderr.write('Error: --cache-only and --runs-only are mutually exclusive\n');
        process.exit(1);
      }

      if (pruneCache) {
        const before = deps.trademarkRepo.count();
        if (options.dryRun === true) {
          process.stdout.write(`Would prune ${before} trademark_results row(s).\n`);
        } else {
          const removed = deps.trademarkRepo.pruneExpired();
          const after = deps.trademarkRepo.count();
          process.stdout.write(`Pruned ${removed} trademark_results row(s); ${after} remain.\n`);
        }
      }

      if (pruneRuns) {
        if (options.before !== undefined) {
          // --before overrides: prune rows started before N days ago
          const cutoff = new Date(Date.now() - options.before * 24 * 60 * 60 * 1000).toISOString();
          const before = deps.runsRepo.count();
          if (options.dryRun === true) {
            const expired = deps.runsRepo.countBefore(cutoff);
            process.stdout.write(`Would prune ${expired} pipeline_runs row(s) started before ${cutoff} (${before} total rows).\n`);
          } else {
            const removed = deps.runsRepo.pruneBefore(cutoff);
            const after = deps.runsRepo.count();
            process.stdout.write(`Pruned ${removed} pipeline_runs row(s) started before ${cutoff}; ${after} remain.\n`);
          }
        } else {
          // Default: prune based on retained_until
          const before = deps.runsRepo.count();
          if (options.dryRun === true) {
            process.stdout.write(`Would prune pipeline_runs rows whose retained_until < now (${before} total rows).\n`);
          } else {
            const removed = deps.runsRepo.prune();
            const after = deps.runsRepo.count();
            process.stdout.write(`Pruned ${removed} pipeline_runs row(s); ${after} remain.\n`);
          }
        }
      }
    });
}
