import type { Command } from 'commander';
import type { PortfolioManager } from '../../portfolio/portfolio-manager.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';

export function registerPortfolioCommand(program: Command, manager: PortfolioManager): void {
  const portfolio = program
    .command('portfolio')
    .description('Manage your domain portfolio');

  portfolio
    .command('list')
    .description('List all portfolio domains with renewal status')
    .action(() => {
      const summaries = manager.list();
      if (summaries.length === 0) {
        process.stdout.write('Portfolio is empty.\n');
        return;
      }
      for (const { entry, renewalClock } of summaries) {
        process.stdout.write(
          `  ${entry.domain.padEnd(30)} verdict: ${entry.verdict.padEnd(8)} days: ${String(renewalClock.daysUntilRenewal).padStart(4)}  cost: €${entry.renewalCost}\n`,
        );
      }
    });

  portfolio
    .command('verdicts')
    .description('Refresh keep/drop/reprice verdicts for all portfolio domains')
    .action(() => {
      manager.refreshVerdicts();
      process.stdout.write('Verdicts refreshed.\n');
    });

  portfolio
    .command('rescore')
    .description('Re-score every portfolio entry against the current engine and TM gate, then refresh verdicts')
    .option('--quiet', 'Suppress per-domain output, print only the summary', false)
    .action((options: { quiet: boolean }) => {
      const portfolioEntries = manager.list();
      if (portfolioEntries.length === 0) {
        process.stdout.write('Portfolio is empty — nothing to rescore.\n');
        return;
      }

      process.stdout.write(`Re-scoring ${portfolioEntries.length} portfolio domain(s)…\n`);

      return manager.rescoreAll().then((summary) => {
        let ok = 0;
        let blocked = 0;
        let errored = 0;

        if (!options.quiet) {
          process.stdout.write('\n');
          for (const r of summary.results) {
            const tm =
              r.trademarkVerdict === GateVerdict.Clear
                ? 'TM:clear'
                : r.trademarkVerdict === GateVerdict.Blocked
                  ? `TM:blocked(${r.matchedMark ?? '?'})`
                  : 'TM:unverified';

            if (r.error !== undefined) {
              errored++;
              process.stdout.write(
                `  ${r.domain.padEnd(30)} ERROR  ${r.error}\n`,
              );
            } else if (!r.trademarkClear && r.trademarkVerdict === GateVerdict.Blocked) {
              blocked++;
              process.stdout.write(
                `  ${r.domain.padEnd(30)} score: ${String(r.calibratedScore).padStart(3)}  list: €${r.suggestedListPrice.toFixed(0).padStart(5)}  ${tm}\n`,
              );
            } else {
              ok++;
              process.stdout.write(
                `  ${r.domain.padEnd(30)} score: ${String(r.calibratedScore).padStart(3)}  list: €${r.suggestedListPrice.toFixed(0).padStart(5)}  ${tm}\n`,
              );
            }
          }
        } else {
          ok = summary.results.filter((r) => r.error === undefined && r.trademarkClear).length;
          blocked = summary.results.filter((r) => r.trademarkVerdict === GateVerdict.Blocked).length;
          errored = summary.results.filter((r) => r.error !== undefined).length;
        }

        process.stdout.write(
          `\nRescore complete in ${summary.totalDurationMs}ms — ${ok} cleared, ${blocked} TM-blocked, ${errored} errored. Verdicts refreshed.\n`,
        );
      });
    });
}
