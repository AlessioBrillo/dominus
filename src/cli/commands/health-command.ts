import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Command } from 'commander';
import { reportProviderStatuses } from '../../app/provider-status.js';
import type { Config } from '../../config.js';

export interface HealthCommandDeps {
  db: Database.Database;
  config: Config;
}

export function registerHealthCommand(program: Command, deps: HealthCommandDeps): void {
  program
    .command('health')
    .description('Check system health: database, version, providers, uptime')
    .option('--json', 'Emit JSON instead of a human-readable report', false)
    .action((options: { json: boolean }) => {
      const version = readVersion();
      const uptime = process.uptime();
      const dbOk = checkDatabase(deps.db);
      const providers = reportProviderStatuses(deps.config);

      if (options.json) {
        process.stdout.write(
          JSON.stringify(
            {
              status: dbOk ? 'ok' : 'degraded',
              version,
              uptime,
              timestamp: new Date().toISOString(),
              database: dbOk ? 'connected' : 'error',
              providers,
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }

      process.stdout.write(formatHealthReport(version, uptime, dbOk, providers));
    });
}

function checkDatabase(db: Database.Database): boolean {
  try {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    return row?.ok === 1;
  } catch {
    return false;
  }
}

function formatHealthReport(
  version: string,
  uptime: number,
  dbOk: boolean,
  providers: ReturnType<typeof reportProviderStatuses>,
): string {
  const lines: string[] = [];

  lines.push(`DOMINUS v${version}`);
  lines.push(`Status:     ${dbOk ? 'ok' : 'degraded'}`);
  lines.push(`Uptime:     ${formatUptime(uptime)}`);
  lines.push(`Database:   ${dbOk ? 'connected' : 'ERROR'}`);
  lines.push('');

  lines.push('Providers:');
  const nameWidth = Math.max(8, ...providers.map((p) => p.name.length));
  for (const p of providers) {
    lines.push(`  ${p.name.padEnd(nameWidth)}  ${p.configured ? 'configured' : 'not configured'}`);
  }

  return lines.join('\n') + '\n';
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

let cachedVersion: string | undefined;

function readVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedVersion = typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}
