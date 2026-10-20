// SPDX-License-Identifier: AGPL-3.0-only
import type { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import type { DatabaseProvider } from '../../db/provider/interface.js';
import { TenantDataService } from '../../services/tenant-data-service.js';

export interface TenantCommandDeps {
  provider: DatabaseProvider;
}

/**
 * Data-subject rights from the command line (GDPR art. 15 and 17).
 *
 * The same operations the API exposes, for the two situations the API
 * cannot cover: an operator of a self-hosted deployment, who is the data
 * controller of their own instance, and a tenant that has lost access to
 * the web interface but still has the CLI.
 *
 * The deletion asks for the tenant id as a typed confirmation, because a
 * deletion that cannot be tied to a deliberate act is an accident waiting
 * to happen.
 */
export function registerTenantCommand(program: Command, deps: TenantCommandDeps): void {
  const service = new TenantDataService(deps.provider);
  const tenant = program
    .command('tenant')
    .description('Data-subject rights: export or erase the data of a tenant');

  tenant
    .command('export')
    .description('Export everything the service holds about a tenant (GDPR art. 15)')
    .requiredOption('--tenant <tenantId>', 'tenant id to export')
    .option('--out <file>', 'write the export to a file instead of stdout')
    .action(async (options: { tenant: string; out?: string }) => {
      const result = await service.exportTenant(options.tenant);
      const json = JSON.stringify(result, null, 2);
      if (options.out) {
        writeFileSync(options.out, json + '\n', 'utf-8');
        process.stdout.write(
          `Exported ${result.totalRows} row(s) across ${result.tables.length} table(s) to ${options.out}\n`,
        );
        return;
      }
      process.stdout.write(json + '\n');
    });

  tenant
    .command('delete')
    .description('Erase everything the service holds about a tenant (GDPR art. 17)')
    .requiredOption('--tenant <tenantId>', 'tenant id to erase')
    .requiredOption('--confirm <tenantId>', 'type the tenant id again to confirm the erasure')
    .action(async (options: { tenant: string; confirm: string }) => {
      if (options.confirm !== options.tenant) {
        process.stderr.write(
          `--confirm must be exactly the tenant id you want to erase (${options.tenant})\n`,
        );
        process.exitCode = 1;
        return;
      }
      const report = await service.deleteTenant(options.tenant);
      process.stdout.write(
        `Erased ${report.totalRows} row(s) across ${report.tables.length} table(s) for tenant ${report.tenantId}.\n`,
      );
      process.stdout.write(
        'Backups are outside this operation: the rolling backup window is overwritten by the rotation.\n',
      );
    });
}
