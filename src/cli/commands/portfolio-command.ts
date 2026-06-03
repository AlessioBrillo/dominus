import type { Command } from 'commander';
import type { PortfolioManager } from '../../portfolio/portfolio-manager.js';

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
}
