import type { Command } from 'commander';
import type { WatchlistService } from '../../watchlist/watchlist-service.js';

export interface WatchlistCommandDeps {
  watchlistService: WatchlistService;
}

export function registerWatchlistCommand(program: Command, deps: WatchlistCommandDeps): void {
  const watchlist = program
    .command('watchlist')
    .description('Manage domains you are watching for availability');

  watchlist
    .command('add <domain>')
    .description('Add a domain to the watchlist')
    .option('--notes <text>', 'Optional notes about this domain')
    .action((domain: string, options: { notes?: string }) => {
      try {
        const entry = deps.watchlistService.add(domain, options.notes);
        process.stdout.write(`Added ${entry.domain} to watchlist (id=${entry.id}).\n`);
      } catch (err: unknown) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
    });

  watchlist
    .command('remove <domain>')
    .description('Remove a domain from the watchlist')
    .action((domain: string) => {
      const removed = deps.watchlistService.remove(domain);
      if (removed) {
        process.stdout.write(`Removed ${domain} from watchlist.\n`);
      } else {
        process.stderr.write(`Domain ${domain} not found in watchlist.\n`);
        process.exit(1);
      }
    });

  watchlist
    .command('list')
    .description('List all watched domains')
    .option('--json', 'Emit JSON instead of a human-readable table', false)
    .action((options: { json: boolean }) => {
      const entries = deps.watchlistService.list();
      if (entries.length === 0) {
        process.stdout.write('Watchlist is empty.\n');
        return;
      }

      if (options.json) {
        process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
        return;
      }

      const lines: string[] = [];
      lines.push(['DOMAIN', 'TLD', 'LAST CHECKED', 'STATUS', 'NOTIFIED'].join('  '));
      for (const e of entries) {
        lines.push(
          [
            e.domain.padEnd(30),
            e.tld.padEnd(8),
            (e.lastCheckedAt ?? '-').padEnd(22),
            (e.lastStatus ?? '-').padEnd(12),
            e.notified ? 'yes' : 'no',
          ].join('  '),
        );
      }
      process.stdout.write(lines.join('\n') + '\n');
    });

  watchlist
    .command('poll')
    .description('Check all watched domains for availability')
    .option('--dry-run', 'Simulate without sending notifications or persisting', false)
    .action(async (options: { dryRun: boolean }) => {
      process.stdout.write(
        options.dryRun ? '[DRY-RUN] Checking watchlist...\n' : 'Checking watchlist...\n',
      );
      try {
        const result = await deps.watchlistService.poll(options.dryRun);
        process.stdout.write(
          `Checked ${result.checked}, available: ${result.available}, notified: ${result.notified}, errors: ${result.errors}\n`,
        );
      } catch (err: unknown) {
        process.stderr.write(
          `Error during poll: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });
}
