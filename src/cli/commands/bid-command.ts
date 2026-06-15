import type { Command } from 'commander';
import type { AcquisitionService } from '../../services/acquisition-service.js';
import { BidStatus, isBidStatus, type Bid } from '../../types/acquisition.js';

export interface BidCommandDeps {
  acquisitionService: AcquisitionService;
}

function formatBid(b: Bid): string {
  const statusIcon =
    b.status === BidStatus.Pending
      ? '\u23F3'
      : b.status === BidStatus.Won
        ? '\u2713'
        : b.status === BidStatus.Lost
          ? '\u2717'
          : b.status === BidStatus.Outbid
            ? '\u2191'
            : '\u2716';
  return (
    `  ${statusIcon} ${b.domain.padEnd(28)} ` +
    `${b.status.padEnd(10)} ` +
    `bid: \u20AC${b.bidAmountEur.toFixed(0).padStart(5)} ` +
    `${b.wonPriceEur !== undefined ? `won: \u20AC${b.wonPriceEur.toFixed(0).padStart(5)} ` : ''}` +
    `${b.venue.padEnd(10)} ` +
    `${b.bidPlacedAt.substring(0, 10)}` +
    `${b.auctionEndsAt !== undefined ? `  ends: ${b.auctionEndsAt.substring(0, 10)}` : ''}`
  );
}

export function registerBidCommand(program: Command, deps: BidCommandDeps): void {
  const { acquisitionService } = deps;

  const bid = program.command('bid').description('Track auction bids for domain acquisitions');

  bid
    .command('place')
    .description('Record a bid placed at an auction')
    .argument('<domain>', 'Domain to bid on')
    .option('--amount <eur>', 'Bid amount in EUR (required)', parseFloat)
    .option(
      '--venue <name>',
      'Auction venue (godaddy, sedo, afternic, namecheap, private)',
      'private',
    )
    .option('--max-bid <eur>', 'Maximum auto-bid amount', parseFloat)
    .option('--ends <iso>', 'Auction end time (ISO-8601)')
    .option('--expected-value <eur>', 'Expected value from latest scoring run', parseFloat)
    .option('--confidence <pct>', 'Confidence score from latest scoring run (0-1)', parseFloat)
    .option('--buy-max <eur>', 'Suggested buy max from latest scoring run', parseFloat)
    .option('--tm-clear', 'Trademark gate passed at bid time', false)
    .option('--notes <text>', 'Optional notes')
    .action(
      async (
        domain: string,
        options: {
          amount?: number;
          venue: string;
          maxBid?: number;
          ends?: string;
          expectedValue?: number;
          confidence?: number;
          buyMax?: number;
          tmClear: boolean;
          notes?: string;
        },
      ) => {
        if (options.amount === undefined || options.amount <= 0) {
          process.stderr.write('Specify a positive --amount.\n');
          process.exit(1);
          return;
        }
        try {
          const bid = await acquisitionService.place({
            domain,
            venue: options.venue,
            bidAmountEur: options.amount,
            maxBidEur: options.maxBid,
            auctionEndsAt: options.ends,
            expectedValueAtBid: options.expectedValue,
            confidenceAtBid: options.confidence,
            suggestedBuyMaxAtBid: options.buyMax,
            trademarkClearAtBid: options.tmClear || undefined,
            notes: options.notes,
          });
          process.stdout.write(
            `\u2713 Bid placed: ${bid.domain} at \u20AC${bid.bidAmountEur.toFixed(2)} on ${bid.venue}\n`,
          );
          if (bid.expectedValueAtBid !== undefined) {
            process.stdout.write(
              `    EV: \u20AC${bid.expectedValueAtBid.toFixed(0)}  ` +
                `Conf: ${((bid.confidenceAtBid ?? 0) * 100).toFixed(0)}%  ` +
                `Buy max: \u20AC${(bid.suggestedBuyMaxAtBid ?? 0).toFixed(0)}\n`,
            );
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`Error: ${message}\n`);
          process.exit(1);
        }
      },
    );

  bid
    .command('resolve')
    .description('Resolve a pending bid (won/lost/outbid/cancelled)')
    .argument('<domain>', 'Domain whose bid to resolve')
    .option('--won', 'Mark bid as won', false)
    .option('--lost', 'Mark bid as lost', false)
    .option('--outbid', 'Mark bid as outbid', false)
    .option('--cancel', 'Cancel bid', false)
    .option('--price <eur>', 'Actual price paid (for won bids)', parseFloat)
    .option(
      '--years <n>',
      'Registration period in years (default: 1)',
      (v) => Number.parseInt(v, 10),
      1,
    )
    .option('--notes <text>', 'Optional notes')
    .action(
      async (
        domain: string,
        options: {
          won: boolean;
          lost: boolean;
          outbid: boolean;
          cancel: boolean;
          price?: number;
          years: number;
          notes?: string;
        },
      ) => {
        const status = options.won
          ? BidStatus.Won
          : options.lost
            ? BidStatus.Lost
            : options.outbid
              ? BidStatus.Outbid
              : options.cancel
                ? BidStatus.Cancelled
                : null;
        if (status === null) {
          process.stderr.write('Specify one of --won, --lost, --outbid, or --cancel.\n');
          process.exit(1);
          return;
        }
        try {
          const bid = await acquisitionService.resolve({
            domain,
            status,
            wonPriceEur: options.price,
            registrationYears: options.years,
            notes: options.notes,
          });
          if (status === BidStatus.Won && bid.wonPriceEur !== undefined) {
            process.stdout.write(
              `\u2713 Won ${domain} at \u20AC${bid.wonPriceEur.toFixed(2)} (${options.years}yr)\n`,
            );
          } else {
            process.stdout.write(`\u2713 Bid for ${domain} resolved as ${status}.\n`);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`Error: ${message}\n`);
          process.exit(1);
        }
      },
    );

  bid
    .command('list')
    .description('List all bids')
    .option('--pending', 'Show only pending bids', false)
    .option('--status <status>', 'Filter by status')
    .action(async (options: { pending: boolean; status?: string }) => {
      const statusFilter = options.pending
        ? BidStatus.Pending
        : options.status !== undefined && isBidStatus(options.status)
          ? (options.status as BidStatus)
          : undefined;
      try {
        const bids = await acquisitionService.list(statusFilter);
        if (bids.length === 0) {
          process.stdout.write('No bids found.\n');
          return;
        }
        for (const b of bids) {
          process.stdout.write(formatBid(b) + '\n');
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });
}
