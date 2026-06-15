import type { Command } from 'commander';
import type { PurchaseService } from '../../services/purchase-service.js';
import { PurchaseNotApprovedError } from '../../types/registrar.js';

export interface BuyCommandDeps {
  purchaseService: PurchaseService;
}

export function registerBuyCommand(program: Command, deps: BuyCommandDeps): void {
  const { purchaseService } = deps;

  const buy = program.command('buy').description('Check price and purchase a domain');

  buy
    .command('check')
    .description('Check price and availability for one or more domains')
    .argument('<domains...>', 'Domain(s) to check')
    .option('--json', 'Emit JSON output', false)
    .action(async (domains: string[], options: { json: boolean }) => {
      for (const domain of domains) {
        try {
          const check = await purchaseService.preflight(domain);
          if (options.json) {
            process.stdout.write(JSON.stringify(check, null, 2) + '\n');
          } else {
            process.stdout.write(
              `  ${domain.padEnd(35)} ` +
                `${check.available ? 'AVAILABLE' : 'UNAVAILABLE'.padEnd(12)} ` +
                `${check.registerPriceEur !== null ? `€${check.registerPriceEur.toFixed(2)}`.padEnd(10) : 'N/A'.padEnd(10)} ` +
                `${check.renewalPriceEur !== null ? `€${check.renewalPriceEur.toFixed(2)}/yr` : ''} ` +
                `${check.expectedValue !== null ? ` EV: €${check.expectedValue.toFixed(0)}` : ''} ` +
                `${check.trademarkClear ? '\u2713 TM clear' : check.trademarkClear === false ? '\u2717 TM' : ''}` +
                '\n',
            );
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`  ${domain}: ERROR ${message}\n`);
        }
      }
    });

  buy
    .command('execute')
    .description('Purchase a domain (checks price, requires confirmation)')
    .argument('<domain>', 'Domain to purchase')
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .option('--years <n>', 'Registration period in years', (v) => Number.parseInt(v, 10), 1)
    .option('--dry-run', 'Check without executing the purchase', false)
    .action(async (domain: string, options: { yes: boolean; years: number; dryRun: boolean }) => {
      try {
        const check = await purchaseService.preflight(domain);

        if (!check.available) {
          process.stderr.write(`Domain ${domain} is not available for registration.\n`);
          process.exit(1);
          return;
        }

        if (!check.trademarkClear) {
          process.stderr.write(`WARNING: Domain ${domain} did NOT pass the trademark gate.\n`);
          if (!options.yes) {
            process.stderr.write('Use --yes to override this warning.\n');
            process.exit(1);
            return;
          }
        }

        const priceStr =
          check.registerPriceEur !== null
            ? `€${check.registerPriceEur.toFixed(2)}`
            : 'Manual (unknown)';
        const renewalStr =
          check.renewalPriceEur !== null ? `€${check.renewalPriceEur.toFixed(2)}/yr` : 'unknown';
        process.stdout.write(`\n  Domain:        ${domain}\n`);
        process.stdout.write(`  Price:         ${priceStr}\n`);
        process.stdout.write(`  Renewal:       ${renewalStr}\n`);
        process.stdout.write(`  Registrar:     ${purchaseService.registrarName}\n`);
        if (check.expectedValue !== null) {
          process.stdout.write(`  Expected Val:  €${check.expectedValue.toFixed(2)}\n`);
          process.stdout.write(`  Confidence:    ${((check.confidence ?? 0) * 100).toFixed(0)}%\n`);
          process.stdout.write(`  Buy Max:       €${(check.suggestedBuyMax ?? 0).toFixed(2)}\n`);
        }
        process.stdout.write(
          `  TM Status:     ${check.trademarkClear ? 'CLEAR' : 'BLOCKED/UNVERIFIED'}\n`,
        );
        process.stdout.write('\n');

        if (options.dryRun) {
          process.stdout.write('[DRY RUN] No purchase was executed.\n');
          return;
        }

        if (!options.yes) {
          process.stdout.write('Proceed with purchase? (y/N): ');
          const answer = await readStdin();
          if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
            process.stdout.write('Purchase cancelled.\n');
            return;
          }
        }

        const result = await purchaseService.execute(domain, options.years, options.yes);
        if (result.success) {
          process.stdout.write(`\u2713 ${result.message ?? 'Purchase successful'}\n`);
        } else {
          process.stderr.write(`\u2717 Purchase failed: ${result.error}\n`);
          process.exit(1);
        }
      } catch (err: unknown) {
        if (err instanceof PurchaseNotApprovedError) {
          process.stderr.write('Operator approval required. Re-run with --yes to confirm.\n');
          process.exit(1);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  buy
    .command('price')
    .description('Check registration price for one or more domains')
    .argument('<domains...>', 'Domain(s) to check')
    .action(async (domains: string[]) => {
      const prices = await purchaseService.checkPrice(domains);
      for (const p of prices) {
        process.stdout.write(
          `  ${p.domain.padEnd(35)} ` +
            `${p.available ? 'AVAILABLE' : 'TAKEN'.padEnd(12)} ` +
            `${p.registerPriceEur !== null ? `€${p.registerPriceEur.toFixed(2)}`.padEnd(10) : 'N/A'.padEnd(10)} ` +
            `${p.renewalPriceEur !== null ? `€${p.renewalPriceEur.toFixed(2)}/yr` : ''}` +
            '\n',
        );
      }
    });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', (data: string) => {
      resolve(data.trim());
    });
  });
}
