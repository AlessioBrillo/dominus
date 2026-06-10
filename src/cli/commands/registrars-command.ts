import type { Command } from 'commander';
import { registrarRegistry } from '../../providers/registrar/registrar-registry.js';
import type { RegistrarDescriptor } from '../../types/registrar.js';

export interface RegistrarsCommandDeps {
  activeRegistrar: string;
}

export function registerRegistrarsCommand(program: Command, deps: RegistrarsCommandDeps): void {
  const registrars = program
    .command('registrars')
    .description('List available registrar providers and their configuration');

  registrars
    .command('list')
    .description('List all available registrar providers')
    .option('--json', 'Emit JSON output', false)
    .action((options: { json: boolean }) => {
      const descriptors = registrarRegistry.listDescriptors();
      if (options.json) {
        process.stdout.write(
          JSON.stringify(
            {
              active: deps.activeRegistrar,
              registrars: descriptors,
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }

      process.stdout.write(`\n  Active registrar: ${deps.activeRegistrar}\n\n`);
      process.stdout.write('  Available registrars:\n');
      for (const d of descriptors) {
        process.stdout.write(`    ${d.name.padEnd(20)} ${d.displayName}\n`);
        process.stdout.write(`    ${' '.repeat(20)} ${d.description.slice(0, 80)}\n`);
        process.stdout.write('\n');
      }
    });

  registrars
    .command('show')
    .description('Show configuration details for a registrar')
    .argument('[name]', 'Registrar name (defaults to active)')
    .option('--json', 'Emit JSON output', false)
    .action((name: string | undefined, options: { json: boolean }) => {
      const target = name ?? deps.activeRegistrar;
      const desc = registrarRegistry.getDescriptor(target);
      if (!desc) {
        process.stderr.write(`Unknown registrar: ${target}\n`);
        process.exit(1);
        return;
      }

      if (options.json) {
        process.stdout.write(JSON.stringify(desc, null, 2) + '\n');
        return;
      }

      printDescriptor(desc, target === deps.activeRegistrar);
    });
}

function printDescriptor(desc: RegistrarDescriptor, isActive: boolean): void {
  process.stdout.write(`\n  ${isActive ? '*' : ' '} ${desc.displayName} (${desc.name})\n`);
  process.stdout.write(`  ${'='.repeat(50)}\n`);
  process.stdout.write(`  ${desc.description}\n`);
  if (desc.website) process.stdout.write(`  Website: ${desc.website}\n`);
  if (desc.docsUrl) process.stdout.write(`  Docs:    ${desc.docsUrl}\n`);
  process.stdout.write(`\n  Configuration:\n`);
  for (const field of desc.configFields) {
    const required = field.required ? ' (required)' : '';
    process.stdout.write(`    ${field.key.padEnd(25)} ${field.label}${required}\n`);
    process.stdout.write(`    ${' '.repeat(25)} ${field.description}\n`);
    const envKey = `REGISTRAR_${desc.name.replace(/-/g, '_').toUpperCase()}_${field.key
      .replace(/([A-Z])/g, '_$1')
      .replace(/^_/, '')
      .toUpperCase()}`;
    process.stdout.write(`    ${' '.repeat(25)} Env: ${envKey}\n`);
  }
  process.stdout.write(
    `\n  Supported TLDs: ${desc.supportedTlds.length > 5 ? `${desc.supportedTlds.slice(0, 5).join(', ')}... (+${desc.supportedTlds.length - 5} more)` : desc.supportedTlds.join(', ')}\n`,
  );
  process.stdout.write(`  Features: ${desc.features.join(', ')}\n\n`);
}
