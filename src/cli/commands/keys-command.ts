// SPDX-License-Identifier: AGPL-3.0-only
import type { Command } from 'commander';
import type { KeyManager } from '../../providers/auth/auth-provider.js';
import type { ApiKeyRepository } from '../../db/repositories/api-key-repository.js';

export interface KeysCommandDeps {
  keyManager: KeyManager | undefined;
  apiKeyRepo: ApiKeyRepository | undefined;
}

/**
 * Operator key management for the Cloud edition (AUTH_PROVIDER=db/auth0).
 *
 * Resolves the admin-bootstrap deadlock: minting the first admin key
 * through the API requires the admin role, which requires an existing
 * admin key. `dominus keys create --tenant <id>` writes the first key
 * straight to the database, outside any tenant/role gate.
 */
export function registerKeysCommand(program: Command, deps: KeysCommandDeps): void {
  if (!deps.keyManager) {
    return;
  }

  const keys = program.command('keys').description('Manage API keys for a tenant (Cloud edition)');

  keys
    .command('create')
    .description('Generate a new API key (shown exactly once)')
    .requiredOption('--tenant <tenantId>', 'tenant ID to create the key for')
    .option('--name <name>', 'key name', 'ops')
    .option('--role <role>', "role for the key: 'admin' or 'member'", 'admin')
    .option('--json', 'Emit JSON output', false)
    .action(async (options: { tenant: string; name: string; role: string; json: boolean }) => {
      const generated = await deps.keyManager!.generate({
        tenantId: options.tenant,
        name: options.name,
        role: options.role,
      });
      if (options.json) {
        process.stdout.write(
          JSON.stringify(
            {
              id: generated.id,
              name: generated.name,
              prefix: generated.prefix,
              key: generated.fullKey,
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }
      process.stdout.write(`API key created for tenant ${options.tenant}:\n`);
      process.stdout.write(`  key:    ${generated.fullKey}\n`);
      process.stdout.write(`  prefix: ${generated.prefix}\n`);
      process.stdout.write(`  role:   ${options.role}\n`);
      process.stdout.write('Save it now — it will not be shown again.\n');
    });

  if (deps.apiKeyRepo) {
    keys
      .command('list')
      .description('List API keys for a tenant')
      .requiredOption('--tenant <tenantId>', 'tenant ID to list keys for')
      .option('--json', 'Emit JSON output', false)
      .action(async (options: { tenant: string; json: boolean }) => {
        const keys = await deps.apiKeyRepo!.findByTenant(options.tenant);
        if (options.json) {
          process.stdout.write(JSON.stringify(keys, null, 2) + '\n');
          return;
        }
        if (keys.length === 0) {
          process.stdout.write(`No API keys found for tenant ${options.tenant}.\n`);
          return;
        }
        for (const k of keys) {
          process.stdout.write(
            `#${k.id}  ${k.keyPrefix}…  ${k.role}  ${k.name}  created ${k.createdAt}\n`,
          );
        }
      });
  }
}
