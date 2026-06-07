import type { Command } from 'commander';
import type { TrademarkRepository } from '../../db/repositories/trademark-repository.js';
import type { PipelineRunsRepository } from '../../db/repositories/pipeline-runs-repository.js';

export interface MaintenanceCommandDeps {
  trademarkRepo: TrademarkRepository;
  runsRepo: PipelineRunsRepository;
}

export function registerMaintenanceCommand(program: Command, deps: MaintenanceCommandDeps): void {
  const maintenance = program.command('maintenance').description('Prune ephemeral data (cached TM results, expired pipeline_runs)');

  maintenance
    .command('prune')
    .description('Delete expired rows from the TM cache and/or the pipeline_runs history')
    .option('--cache-only', 'Prune only the trademark_results cache')
    .option('--runs-only', 'Prune only the pipeline_runs history')
    .option('--dry-run', 'Print counts of rows that would be removed without writing')
    .action((options: { cacheOnly?: boolean; runsOnly?: boolean; dryRun?: boolean }) => {
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
        const before = deps.runsRepo.count();
        if (options.dryRun === true) {
          process.stdout.write(`Would prune pipeline_runs rows whose retained_until < now (${before} total rows).\n`);
        } else {
          const removed = deps.runsRepo.prune();
          const after = deps.runsRepo.count();
          process.stdout.write(`Pruned ${removed} pipeline_runs row(s); ${after} remain.\n`);
        }
      }
    });
}
