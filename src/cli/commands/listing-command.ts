import { type Command } from 'commander';
import type { ListingManager } from '../../listing/listing-manager.js';

import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface ListingCommandOptions {
  listingManager: ListingManager;
}

export function registerListingCommand(program: Command, options: ListingCommandOptions): void {
  const { listingManager } = options;

  const listingCommand = program
    .command('listing')
    .description('Manage domain marketplace listings');

  listingCommand
    .command('list')
    .description('Show all listings')
    .option('--status <status>', 'Filter by status (draft, listed, sold, expired)')
    .option('--marketplace <name>', 'Filter by marketplace (dan, afternic, manual)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const filter: { status?: string; marketplace?: string } = {};
        if (opts.status) filter.status = opts.status;
        if (opts.marketplace) filter.marketplace = opts.marketplace;
        const listings = listingManager.getListings(filter as never);

        if (opts.json) {
          console.log(JSON.stringify(listings, null, 2));
          return;
        }

        if (listings.length === 0) {
          console.log('No listings found.');
          return;
        }

        console.log('\nListings:');
        console.log('-'.repeat(100));
        console.log(
          '  ID  Domain                    Marketplace  Price    Status           Listed',
        );
        console.log('-'.repeat(100));
        for (const l of listings) {
          const listed = l.listedAt ? new Date(l.listedAt).toLocaleDateString() : '-';
          console.log(
            `${String(l.id).padStart(4)} ${l.domain.padEnd(25)} ${l.marketplace.padEnd(11)} ${l.priceEur.toFixed(0).padStart(7)} ${l.status.padEnd(15)} ${listed}`,
          );
        }
        console.log('-'.repeat(100));
        console.log(`Total: ${listings.length}`);
      } catch (err) {
        logger.error({ err }, 'listing list failed');
        process.exitCode = 1;
      }
    });

  listingCommand
    .command('create <domain>')
    .description('Create a new listing for a domain')
    .option('-p, --price <number>', 'Listing price in EUR', parseFloat)
    .option('-m, --marketplace <name>', 'Marketplace name (dan, afternic, manual)', 'manual')
    .option('--notes <text>', 'Optional notes')
    .action(async (domain, opts) => {
      try {
        const listing = await listingManager.listDomain(domain, opts.marketplace, opts.price, {
          notes: opts.notes,
        });
        console.log(
          `Listing created: ${listing.domain} on ${listing.marketplace} for ${listing.priceEur} EUR [${listing.status}]`,
        );
      } catch (err) {
        logger.error({ err, domain }, 'listing create failed');
        process.exitCode = 1;
      }
    });

  listingCommand
    .command('publish <id>')
    .description('Publish a draft listing to the marketplace')
    .action(async (idStr) => {
      try {
        const id = parseInt(idStr, 10);
        const listing = await listingManager.listOnMarketplace(id);
        console.log(
          `Listing ${id} published: ${listing.domain} on ${listing.marketplace} [${listing.status}]`,
        );
      } catch (err) {
        logger.error({ err, listingId: idStr }, 'listing publish failed');
        process.exitCode = 1;
      }
    });

  listingCommand
    .command('update <id>')
    .description('Update a listing')
    .option('-p, --price <number>', 'New price in EUR', parseFloat)
    .option('--status <status>', 'New status')
    .option('--notes <text>', 'Notes')
    .action(async (idStr, opts) => {
      try {
        const id = parseInt(idStr, 10);
        const update: Record<string, unknown> = {};
        if (opts.price !== undefined) update.priceEur = opts.price;
        if (opts.status) update.status = opts.status;
        if (opts.notes !== undefined) update.notes = opts.notes;

        const listing = await listingManager.updateListing(id, update as never);
        console.log(
          `Listing ${id} updated: ${listing.domain} — ${listing.priceEur} EUR [${listing.status}]`,
        );
      } catch (err) {
        logger.error({ err, listingId: idStr }, 'listing update failed');
        process.exitCode = 1;
      }
    });

  listingCommand
    .command('delete <id>')
    .description('Delete a listing')
    .action(async (idStr) => {
      try {
        const id = parseInt(idStr, 10);
        await listingManager.deleteListing(id);
        console.log(`Listing ${id} deleted.`);
      } catch (err) {
        logger.error({ err, listingId: idStr }, 'listing delete failed');
        process.exitCode = 1;
      }
    });

  listingCommand
    .command('offers <id>')
    .description('Show offers for a listing')
    .option('--json', 'Output as JSON')
    .action(async (idStr, opts) => {
      try {
        const id = parseInt(idStr, 10);
        const offers = listingManager.getOffers(id);
        const listing = listingManager.getListing(id);

        if (opts.json) {
          console.log(JSON.stringify({ listing, offers }, null, 2));
          return;
        }

        if (!listing) {
          console.log(`Listing ${id} not found.`);
          return;
        }

        console.log(`\nOffers for ${listing.domain} (${listing.marketplace}):`);
        console.log('-'.repeat(80));
        if (offers.length === 0) {
          console.log('  No offers received.');
        } else {
          console.log('  ID    Amount    Buyer                 Status     Received');
          console.log('-'.repeat(80));
          for (const o of offers) {
            const received = new Date(o.receivedAt).toLocaleDateString();
            console.log(
              `${String(o.id).padStart(5)} ${o.amountEur.toFixed(0).padStart(8)} ${o.buyer.padEnd(20)} ${o.status.padEnd(10)} ${received}`,
            );
          }
          console.log('-'.repeat(80));
          console.log(`Total: ${offers.length}`);
        }
      } catch (err) {
        logger.error({ err, listingId: idStr }, 'listing offers failed');
        process.exitCode = 1;
      }
    });

  listingCommand
    .command('offer <listing-id> <amount> <buyer>')
    .description('Record a manual offer')
    .option('--notes <text>', 'Notes')
    .action(async (listingIdStr, amountStr, buyer, opts) => {
      try {
        const listingId = parseInt(listingIdStr, 10);
        const amount = parseFloat(amountStr);
        const offer = await listingManager.recordOffer(listingId, amount, buyer, opts.notes);
        console.log(`Offer recorded: ${offer.amountEur} EUR from ${offer.buyer} [${offer.status}]`);
      } catch (err) {
        logger.error({ err }, 'listing offer record failed');
        process.exitCode = 1;
      }
    });

  listingCommand
    .command('accept <offer-id> <listing-id>')
    .description('Accept an offer')
    .action(async (offerIdStr, listingIdStr) => {
      try {
        listingManager.respondToOffer(
          parseInt(offerIdStr, 10),
          parseInt(listingIdStr, 10),
          'accepted',
        );
        console.log(`Offer ${offerIdStr} accepted.`);
      } catch (err) {
        logger.error({ err }, 'listing accept failed');
        process.exitCode = 1;
      }
    });

  listingCommand
    .command('decline <offer-id> <listing-id>')
    .description('Decline an offer')
    .action(async (offerIdStr, listingIdStr) => {
      try {
        listingManager.respondToOffer(
          parseInt(offerIdStr, 10),
          parseInt(listingIdStr, 10),
          'declined',
        );
        console.log(`Offer ${offerIdStr} declined.`);
      } catch (err) {
        logger.error({ err }, 'listing decline failed');
        process.exitCode = 1;
      }
    });

  listingCommand
    .command('sync')
    .description('Sync listings with marketplace')
    .action(async () => {
      try {
        console.log('Syncing listings with marketplace...');
        const result = await listingManager.syncAll();
        console.log(
          `Sync complete: ${result.listings.length} listings, ${result.offers.length} offers`,
        );
        if (result.errors.length > 0) {
          console.log(`Errors (${result.errors.length}):`);
          for (const err of result.errors) {
            console.log(`  - ${err}`);
          }
        }
      } catch (err) {
        logger.error({ err }, 'listing sync failed');
        process.exitCode = 1;
      }
    });
}
