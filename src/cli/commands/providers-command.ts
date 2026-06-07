import type { Command } from 'commander';
import type { Config } from '../../config.js';
import { reportProviderStatuses, type ProviderStatus } from '../../app/provider-status.js';

export interface ProvidersCommandDeps {
  config: Config;
}

export function registerProvidersCommand(program: Command, deps: ProvidersCommandDeps): void {
  const providers = program.command('providers').description('Inspect the runtime status of every external provider');

  providers
    .command('status')
    .description('Show whether each provider is configured and how missing config is handled')
    .option('--json', 'Emit JSON instead of a human-readable table', false)
    .action((options: { json: boolean }) => {
      const rows = reportProviderStatuses(deps.config);
      if (options.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
        return;
      }
      process.stdout.write(formatTable(rows));
    });
}

function formatTable(rows: ProviderStatus[]): string {
  const nameWidth = Math.max(8, ...rows.map((r) => r.name.length));
  const configuredWidth = 11;
  const lines: string[] = [];
  lines.push(['PROVIDER'.padEnd(nameWidth), 'CONFIGURED'.padEnd(configuredWidth), 'NOTE'].join('  '));
  for (const r of rows) {
    lines.push(
      [
        r.name.padEnd(nameWidth),
        (r.configured ? 'yes' : 'no').padEnd(configuredWidth),
        r.note,
      ].join('  '),
    );
  }
  return lines.join('\n') + '\n';
}
