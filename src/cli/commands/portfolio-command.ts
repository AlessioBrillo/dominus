import type { Command } from 'commander';
import type { PortfolioManager } from '../../portfolio/portfolio-manager.js';
import type { RenewalAlertEngine } from '../../portfolio/renewal-alert-engine.js';
import type { RenewalAlertRepository } from '../../db/repositories/renewal-alert-repository.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';

export interface PortfolioCommandDeps {
  manager: PortfolioManager;
  alertEngine?: RenewalAlertEngine | undefined;
  alertRepo?: RenewalAlertRepository | undefined;
}

export function registerPortfolioCommand(program: Command, deps: PortfolioCommandDeps): void {
  const { manager, alertEngine, alertRepo } = deps;
  const portfolio = program.command('portfolio').description('Manage your domain portfolio');

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
    .command('update-costs')
    .description('Update acquisition and/or renewal cost for a portfolio domain')
    .argument('<domain>', 'Domain to update')
    .option('--acquisition-cost <eur>', 'New acquisition cost in EUR', parseFloat)
    .option('--renewal-cost <eur>', 'New annual renewal cost in EUR', parseFloat)
    .action((domain: string, options: { acquisitionCost?: number; renewalCost?: number }) => {
      if (options.acquisitionCost === undefined && options.renewalCost === undefined) {
        process.stderr.write('Specify at least --acquisition-cost or --renewal-cost.\n');
        process.exit(1);
        return;
      }
      try {
        manager.updateCosts(domain, options.acquisitionCost, options.renewalCost);
        process.stdout.write(`Costs updated for ${domain}.\n`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  portfolio
    .command('rescore')
    .description(
      'Re-score every portfolio entry against the current engine and TM gate, then refresh verdicts',
    )
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
              process.stdout.write(`  ${r.domain.padEnd(30)} ERROR  ${r.error}\n`);
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
          blocked = summary.results.filter(
            (r) => r.trademarkVerdict === GateVerdict.Blocked,
          ).length;
          errored = summary.results.filter((r) => r.error !== undefined).length;
        }

        process.stdout.write(
          `\nRescore complete in ${summary.totalDurationMs}ms — ${ok} cleared, ${blocked} TM-blocked, ${errored} errored. Verdicts refreshed.\n`,
        );
      });
    });

  // ── Alerts subcommands ──────────────────────────────────────────────

  const alerts = portfolio.command('alerts').description('Manage renewal alerts');

  alerts
    .command('list')
    .description('List renewal alerts')
    .option('--domain <domain>', 'Filter by domain')
    .option('--unacknowledged', 'Show only unacknowledged alerts', false)
    .option('--json', 'Emit JSON instead of a human-readable table', false)
    .action((options: { domain?: string; unacknowledged: boolean; json: boolean }) => {
      if (!alertRepo) {
        process.stderr.write('Alert repository not available.\n');
        return;
      }
      const alertsList = alertRepo.findAll(options.domain, options.unacknowledged);
      if (alertsList.length === 0) {
        if (options.json) {
          process.stdout.write('[]\n');
        } else {
          process.stdout.write('No alerts found.\n');
        }
        return;
      }
      if (options.json) {
        process.stdout.write(JSON.stringify(alertsList, null, 2) + '\n');
        return;
      }
      const lines: string[] = [];
      lines.push(['ID', 'DOMAIN', 'TYPE', 'SEVERITY', 'ACKED', 'MESSAGE'].join('  '));
      for (const a of alertsList) {
        lines.push(
          [
            String(a.id ?? '').padStart(3),
            a.domain.padEnd(30),
            a.alertType.padEnd(18),
            a.severity.padEnd(8),
            a.acknowledgedAt ? 'yes' : 'no ',
            a.message,
          ].join('  '),
        );
      }
      process.stdout.write(lines.join('\n') + '\n');
    });

  alerts
    .command('acknowledge')
    .description('Acknowledge one or all alerts')
    .option('--id <n>', 'Alert ID to acknowledge', (v: string) => Number.parseInt(v, 10))
    .option('--domain <domain>', 'Acknowledge all alerts for a domain')
    .option('--all', 'Acknowledge every unacknowledged alert', false)
    .action((options: { id?: number; domain?: string; all: boolean }) => {
      if (!alertRepo) {
        process.stderr.write('Alert repository not available.\n');
        return;
      }
      if (options.id !== undefined) {
        alertRepo.acknowledge(options.id);
        process.stdout.write(`Alert ${options.id} acknowledged.\n`);
      } else if (options.all) {
        const n = alertRepo.acknowledgeAll(options.domain);
        process.stdout.write(`${n} alert(s) acknowledged.\n`);
      } else {
        process.stderr.write('Specify --id <n>, --domain, or --all.\n');
        process.exit(1);
      }
    });

  alerts
    .command('run')
    .description('Run the renewal alert check now')
    .action(async () => {
      if (!alertEngine) {
        process.stderr.write('Alert engine not available.\n');
        process.exit(1);
        return;
      }
      try {
        const result = await alertEngine.checkAll();
        process.stdout.write(`Alert check complete. Generated ${result.generated} alert(s).\n`);
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });
}
