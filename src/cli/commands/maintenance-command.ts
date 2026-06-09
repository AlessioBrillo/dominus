import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import type Database from 'better-sqlite3';
import type { TrademarkRepository } from '../../db/repositories/trademark-repository.js';
import type { PipelineRunsRepository } from '../../db/repositories/pipeline-runs-repository.js';
import type { CandidateRepository } from '../../db/repositories/candidate-repository.js';

export interface MaintenanceCommandDeps {
  db: Database.Database;
  trademarkRepo: TrademarkRepository;
  runsRepo: PipelineRunsRepository;
  candidateRepo: CandidateRepository;
}

export function registerMaintenanceCommand(program: Command, deps: MaintenanceCommandDeps): void {
  const maintenance = program
    .command('maintenance')
    .description('Prune ephemeral data, backup the database');

  maintenance
    .command('backup')
    .description('Create a safe, consistent SQLite backup via VACUUM INTO')
    .argument('[path]', 'Output path for the backup file (default: ./data/dominus-<YYYY-MM-DD>.db)')
    .action((backupPath?: string) => {
      const path = backupPath ?? `./data/dominus-${new Date().toISOString().slice(0, 10)}.db`;
      const absPath = resolve(process.cwd(), path);
      mkdirSync(dirname(absPath), { recursive: true });

      deps.db.pragma('wal_checkpoint(TRUNCATE)');
      if (absPath.includes("'")) {
        process.stderr.write('Error: backup path must not contain single quotes\n');
        process.exit(1);
      }
      deps.db.exec(`VACUUM INTO '${absPath}'`);

      process.stdout.write(`Backup written to ${absPath}\n`);
    });

  maintenance
    .command('prune')
    .description(
      'Delete expired rows from the TM cache, pipeline_runs history, and rescore candidates',
    )
    .option('--cache-only', 'Prune only the trademark_results cache')
    .option('--runs-only', 'Prune only the pipeline_runs history')
    .option('--rescore-only', 'Prune only synthetic portfolio_rescore candidates')
    .option(
      '--before <days>',
      'Prune pipeline_runs or rescore candidates older than N days (default: 90)',
      parseInt,
    )
    .option('--dry-run', 'Print counts of rows that would be removed without writing')
    .action(
      (options: {
        cacheOnly?: boolean;
        runsOnly?: boolean;
        rescoreOnly?: boolean;
        before?: number;
        dryRun?: boolean;
      }) => {
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

        const pruneCache = options.runsOnly !== true && options.rescoreOnly !== true;
        const pruneRuns = options.cacheOnly !== true && options.rescoreOnly !== true;
        const pruneRescore = options.rescoreOnly === true;
        const retentionDays = options.before ?? 90;

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
            const cutoff = new Date(
              Date.now() - options.before * 24 * 60 * 60 * 1000,
            ).toISOString();
            const before = deps.runsRepo.count();
            if (options.dryRun === true) {
              const expired = deps.runsRepo.countBefore(cutoff);
              process.stdout.write(
                `Would prune ${expired} pipeline_runs row(s) started before ${cutoff} (${before} total rows).\n`,
              );
            } else {
              const removed = deps.runsRepo.pruneBefore(cutoff);
              const after = deps.runsRepo.count();
              process.stdout.write(
                `Pruned ${removed} pipeline_runs row(s) started before ${cutoff}; ${after} remain.\n`,
              );
            }
          } else {
            const before = deps.runsRepo.count();
            if (options.dryRun === true) {
              process.stdout.write(
                `Would prune pipeline_runs rows whose retained_until < now (${before} total rows).\n`,
              );
            } else {
              const removed = deps.runsRepo.prune();
              const after = deps.runsRepo.count();
              process.stdout.write(`Pruned ${removed} pipeline_runs row(s); ${after} remain.\n`);
            }
          }
        }

        if (pruneRescore) {
          const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
          const before = deps.candidateRepo.countRescoreCandidates(cutoff);
          if (options.dryRun === true) {
            process.stdout.write(
              `Would prune ${before} portfolio_rescore candidate(s) created before ${cutoff}.\n`,
            );
          } else {
            const removed = deps.candidateRepo.pruneRescoreCandidates(cutoff);
            const after = deps.candidateRepo.countRescoreCandidates(cutoff);
            process.stdout.write(
              `Pruned ${removed} portfolio_rescore candidate(s) created before ${cutoff}; ${after} remain.\n`,
            );
          }
        }
      },
    );
}
