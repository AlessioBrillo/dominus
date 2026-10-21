// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Command } from 'commander';
import { reportProviderStatuses } from '../../app/provider-status.js';
import type { DatabaseProvider } from '../../db/provider/interface.js';
import type { Config } from '../../config.js';

export interface HealthCommandDeps {
  db: Database.Database | null;
  config: Config;
  /**
   * The database provider. In PostgreSQL mode (the Cloud edition) there
   * is no better-sqlite3 handle at all, and this command used to
   * dereference a null one: the health check of a Cloud deployment
   * crashed instead of reporting. The provider knows whether its
   * connection is open, which is the same question this command asks.
   */
  provider?: DatabaseProvider | undefined;
}

interface DatabaseStatus {
  ok: boolean;
  label: string;
}

export function registerHealthCommand(program: Command, deps: HealthCommandDeps): void {
  program
    .command('health')
    .description('Check system health: database, version, providers, uptime')
    .option('--json', 'Emit JSON instead of a human-readable report', false)
    .action((options: { json: boolean }) => {
      const version = readVersion();
      const uptime = process.uptime();
      const database = describeDatabase(deps.db, deps.provider);
      const providers = reportProviderStatuses(deps.config);

      if (options.json) {
        process.stdout.write(
          JSON.stringify(
            {
              status: database.ok ? 'ok' : 'degraded',
              version,
              uptime,
              timestamp: new Date().toISOString(),
              database: database.ok ? 'connected' : 'error',
              databaseEngine: database.label,
              providers,
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }

      process.stdout.write(
        formatHealthReport(version, uptime, database.ok, database.label, providers),
      );
    });
}

function describeDatabase(
  db: Database.Database | null,
  provider: DatabaseProvider | undefined,
): DatabaseStatus {
  if (db) {
    try {
      const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      return { ok: row?.ok === 1, label: 'sqlite' };
    } catch {
      return { ok: false, label: 'sqlite' };
    }
  }
  // PostgreSQL mode: the provider knows whether the pool is open.
  return { ok: provider?.isOpen() === true, label: 'postgresql' };
}

function formatHealthReport(
  version: string,
  uptime: number,
  dbOk: boolean,
  dbLabel: string,
  providers: ReturnType<typeof reportProviderStatuses>,
): string {
  const lines: string[] = [];

  lines.push(`DOMINUS v${version}`);
  lines.push(`Status:     ${dbOk ? 'ok' : 'degraded'}`);
  lines.push(`Uptime:     ${formatUptime(uptime)}`);
  lines.push(`Database:   ${dbOk ? 'connected' : 'ERROR'} (${dbLabel})`);
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
