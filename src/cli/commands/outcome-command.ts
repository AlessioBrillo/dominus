import type { Command } from 'commander';
import type { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import { isOutcomeType, OUTCOME_TYPES } from '../../types/outcome.js';

export function registerOutcomeCommand(program: Command, repo: OutcomeRepository): void {
  const outcome = program
    .command('outcome')
    .description('Record and inspect real-world outcomes for portfolio domains');

  outcome
    .command('record')
    .description('Record a new outcome (sold / dropped / expired / renewed) for a portfolio domain')
    .requiredOption('-d, --domain <domain>', 'portfolio domain the outcome applies to')
    .requiredOption('-t, --type <type>', `outcome type, one of: ${OUTCOME_TYPES.join(', ')}`)
    .requiredOption('--occurred-at <iso>', 'when the outcome happened (ISO 8601, e.g. 2026-04-15)')
    .option('--sale-price <eur>', 'sale price in EUR (recommended for "sold")', parseFloat)
    .option('--listing-price <eur>', 'listing price at the time of sale, in EUR', parseFloat)
    .option('--days-listed <days>', 'days the domain was listed before this outcome', parseInt)
    .option('--venue <venue>', 'marketplace or venue where the outcome occurred')
    .option('--commission-pct <pct>', 'commission paid, as a percentage', parseFloat)
    .option('--notes <notes>', 'free-form notes')
    .action(
      async (options: {
        domain: string;
        type: string;
        occurredAt: string;
        salePrice?: number;
        listingPrice?: number;
        daysListed?: number;
        venue?: string;
        commissionPct?: number;
        notes?: string;
      }) => {
        if (!isOutcomeType(options.type)) {
          process.stderr.write(
            `Error: invalid outcome type '${options.type}'. Valid: ${OUTCOME_TYPES.join(', ')}\n`,
          );
          process.exit(1);
        }

        if (Number.isNaN(Date.parse(options.occurredAt))) {
          process.stderr.write(`Error: invalid --occurred-at value: ${options.occurredAt}\n`);
          process.exit(1);
        }

        try {
          const out = await repo.insert({
            domain: options.domain,
            type: options.type,
            occurredAt: new Date(options.occurredAt).toISOString(),
            salePriceEur: options.salePrice,
            listingPriceEur: options.listingPrice,
            daysListed: options.daysListed,
            venue: options.venue,
            commissionPct: options.commissionPct,
            notes: options.notes,
          });
          process.stdout.write(
            `Recorded outcome #${out.id} (${out.type}) for ${out.domain} at ${out.occurredAt}\n`,
          );
        } catch (err: unknown) {
          process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        }
      },
    );

  outcome
    .command('list')
    .description('List recorded outcomes, optionally filtered by domain or type')
    .option('-d, --domain <domain>', 'filter to a specific domain')
    .option('-t, --type <type>', `filter to a specific type, one of: ${OUTCOME_TYPES.join(', ')}`)
    .action(async (options: { domain?: string; type?: string }) => {
      let outcomes;
      if (options.domain !== undefined) {
        outcomes = await repo.findByDomain(options.domain);
      } else if (options.type !== undefined) {
        if (!isOutcomeType(options.type)) {
          process.stderr.write(
            `Error: invalid --type '${options.type}'. Valid: ${OUTCOME_TYPES.join(', ')}\n`,
          );
          process.exit(1);
        }
        outcomes = await repo.findByType(options.type);
      } else {
        outcomes = await repo.findAll();
      }

      if (outcomes.length === 0) {
        process.stdout.write('No outcomes recorded.\n');
        return;
      }

      process.stdout.write(
        `${'ID'.padStart(5)}  ${'Date'.padEnd(11)}  ${'Type'.padEnd(8)}  ${'Domain'.padEnd(30)}  Sale €   Notes\n`,
      );
      for (const o of outcomes) {
        const date = o.occurredAt.slice(0, 10);
        const sale = o.salePriceEur !== undefined ? `€${o.salePriceEur.toFixed(0)}` : '—';
        process.stdout.write(
          `${String(o.id ?? '?').padStart(5)}  ${date.padEnd(11)}  ${o.type.padEnd(8)}  ${o.domain.padEnd(30)}  ${sale.padStart(7)}   ${o.notes ?? ''}\n`,
        );
      }
    });

  outcome
    .command('stats')
    .description('Show aggregate stats (counts + realised revenue) for a portfolio domain')
    .requiredOption('-d, --domain <domain>', 'portfolio domain to summarise')
    .action(async (options: { domain: string }) => {
      const stats = await repo.statsByDomain(options.domain);
      process.stdout.write(`Outcomes for ${options.domain}:\n`);
      process.stdout.write(`  sold:     ${stats.sold}\n`);
      process.stdout.write(`  dropped:  ${stats.dropped}\n`);
      process.stdout.write(`  expired:  ${stats.expired}\n`);
      process.stdout.write(`  renewed:  ${stats.renewed}\n`);
      process.stdout.write(`  total realised: €${stats.totalRealisedEur.toFixed(2)}\n`);
    });
}
