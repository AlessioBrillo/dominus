import type { Command } from 'commander';
import type { AcquisitionService } from '../../services/acquisition-service.js';
import { BidStatus, type Bid } from '../../types/acquisition.js';

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
    `  ${statusIcon} ${b.domain.padEnd(30)} ` +
    `${b.status.padEnd(10)} ` +
    `bid: \u20AC${b.bidAmountEur.toFixed(0).padStart(5)} ` +
    `${b.wonPriceEur !== undefined ? `won: \u20AC${b.wonPriceEur.toFixed(0).padStart(5)} ` : ''}` +
    `${b.venue.padEnd(12)} ` +
    `${b.bidPlacedAt.substring(0, 10)}`
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
    .option('--notes <text>', 'Optional notes')
    .action(
      async (
        domain: string,
        options: {
          amount?: number;
          venue: string;
          maxBid?: number;
          ends?: string;
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
            notes: options.notes,
          });
          process.stdout.write(
            `\u2713 Bid placed: ${bid.domain} at \u20AC${bid.bidAmountEur.toFixed(2)} on ${bid.venue}\n`,
          );
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
          await acquisitionService.resolve({
            domain,
            status,
            wonPriceEur: options.price,
            notes: options.notes,
          });
          process.stdout.write(`\u2713 Bid for ${domain} resolved as ${status}.\n`);
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

function isBidStatus(value: string): value is keyof typeof BidStatus {
  return Object.values(BidStatus).includes(value as BidStatus);
}
