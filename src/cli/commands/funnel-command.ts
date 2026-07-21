import type { Command } from 'commander';
import type { AcquisitionFunnelService } from '../../services/acquisition-funnel-service.js';

export interface FunnelCommandDeps {
  funnelService: AcquisitionFunnelService;
}

function formatEur(value: number): string {
  return `\u20AC${value.toFixed(0)}`;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function registerFunnelCommand(program: Command, deps: FunnelCommandDeps): void {
  const { funnelService } = deps;

  const funnel = program
    .command('funnel')
    .description('Acquisition funnel — budget-driven buy-list prioritisation');

  funnel
    .command('generate')
    .description('Generate acquisition funnel for a pipeline run')
    .argument('<runId>', 'Pipeline run ID')
    .option('--budget <eur>', 'Budget cap in EUR', parseFloat)
    .option('--min-confidence <pct>', 'Minimum confidence (0-1)', parseFloat)
    .option('--min-buy-max <eur>', 'Minimum suggested buy max in EUR', parseFloat)
    .option('--max-entries <n>', 'Maximum entries in buy-list', parseInt)
    .action(
      async (
        runId: string,
        options: {
          budget?: number;
          minConfidence?: number;
          minBuyMax?: number;
          maxEntries?: number;
        },
      ) => {
        try {
          const result = await funnelService.generateFunnel(runId, options);

          process.stdout.write(`Acquisition Funnel: ${runId}\n`);
          process.stdout.write(`\n`);

          if (result.entries.length === 0) {
            process.stdout.write('No candidates passed the acquisition filters.\n');
            process.stdout.write(
              `  Total candidates in run: ${result.breakdown.totalCandidates}\n`,
            );
            return;
          }

          process.stdout.write(
            `Budget: ${formatEur(result.config.budgetEur)}  |  ` +
              `Used: ${formatEur(result.breakdown.budgetUsedEur)}  |  ` +
              `Remaining: ${formatEur(result.breakdown.budgetRemainingEur)}\n`,
          );
          process.stdout.write(
            `Expected ROI: ${formatPct(result.breakdown.expectedRoi)}  |  ` +
              `Avg confidence: ${formatPct(result.breakdown.averageConfidence)}  |  ` +
              `Entries: ${result.entries.length}\n`,
          );
          process.stdout.write(`\n`);

          for (const entry of result.entries) {
            process.stdout.write(
              `  ${entry.domain.padEnd(28)} ` +
                `EV: ${formatEur(entry.expectedValue).padStart(6)} ` +
                `Conf: ${formatPct(entry.confidence).padStart(5)} ` +
                `Alloc: ${formatEur(entry.budgetAllocationEur).padStart(5)} ` +
                `Return: ${formatEur(entry.expectedReturnEur).padStart(6)} ` +
                `Priority: ${entry.priorityScore.toFixed(1).padStart(6)}\n`,
            );
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`Error: ${message}\n`);
          process.exit(1);
        }
      },
    );

  funnel
    .command('show')
    .description('Show the acquisition funnel for a pipeline run')
    .argument('<runId>', 'Pipeline run ID')
    .action(async (runId: string) => {
      try {
        const result = await funnelService.getFunnel(runId);

        if (!result || result.entries.length === 0) {
          process.stdout.write(`No acquisition funnel found for run ${runId}.\n`);
          process.stdout.write('Run `dominus funnel generate <runId>` first.\n');
          return;
        }

        process.stdout.write(`Acquisition Funnel: ${runId}\n`);
        process.stdout.write(
          `Budget: ${formatEur(result.config.budgetEur)}  |  ` +
            `Used: ${formatEur(result.breakdown.budgetUsedEur)}  |  ` +
            `Entries: ${result.entries.length}\n`,
        );
        process.stdout.write(`Expected ROI: ${formatPct(result.breakdown.expectedRoi)}\n`);
        process.stdout.write(`\n`);

        for (const entry of result.entries) {
          process.stdout.write(
            `  ${entry.domain.padEnd(28)} ` +
              `EV: ${formatEur(entry.expectedValue).padStart(6)} ` +
              `Alloc: ${formatEur(entry.budgetAllocationEur).padStart(5)} ` +
              `Status: ${entry.status.padEnd(10)}\n`,
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });
}
