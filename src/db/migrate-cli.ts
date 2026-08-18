// SPDX-License-Identifier: AGPL-3.0-only
// Standalone schema migration CLI (migrate-before-roll, ADR-0061).
//
// Usage:
//   node dist/db/migrate-cli.js            # apply pending migrations
//   node dist/db/migrate-cli.js --help
//
// Applies pending schema migrations through the dialect-aware provider,
// behind the same fail-closed gate the application boot uses
// (ensureSchemaUpToDate). Deploy usage — run the TARGET image against the
// live database before the rollout:
//
//   DOMINUS_IMAGE_TAG=v1.1.0 docker compose run --no-deps \
//     --entrypoint node api dist/db/migrate-cli.js
//
// Exit codes:
//   0 — schema is up to date (migrations may have been applied)
//   1 — gate refused or migration failed — no images should be rolled
//   2 — usage error
import { pathToFileURL } from 'node:url';
import type { Config } from '../config.js';
import { loadConfig as loadConfigDefault } from '../config.js';
import { createDatabaseProvider } from './index.js';
import type { DatabaseProvider } from './provider/interface.js';
import { readAppliedMigrations } from './migration-manifest.js';
import { ensureSchemaUpToDate } from './migrator.js';

export const MIGRATE_CLI_USAGE = `Usage: migrate-cli.js [--help]

Applies pending schema migrations to the database configured via
DATABASE_URL (PostgreSQL) or DATABASE_PATH (SQLite), behind the same
fail-closed schema gate the application boot uses.

Exit codes:
  0  schema is up to date (migrations may have been applied)
  1  gate refused or migration failed — no images should be rolled
  2  usage error
`;

export interface MigrateCliDeps {
  loadConfig?: () => Config;
  createProvider?: (config: Config) => Promise<DatabaseProvider>;
}

export interface MigrateCliResult {
  exitCode: 0 | 1 | 2;
  appliedBefore: number;
  appliedAfter: number;
  reason?: string;
}

export async function runMigrateCli(
  argv: string[],
  deps: MigrateCliDeps = {},
): Promise<MigrateCliResult> {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(MIGRATE_CLI_USAGE);
    return { exitCode: 0, appliedBefore: 0, appliedAfter: 0 };
  }
  if (argv.length > 0) {
    process.stderr.write(MIGRATE_CLI_USAGE);
    return {
      exitCode: 2,
      appliedBefore: 0,
      appliedAfter: 0,
      reason: `unknown arguments: ${argv.join(' ')}`,
    };
  }

  const loadConfig = deps.loadConfig ?? loadConfigDefault;
  const createProvider = deps.createProvider ?? createDatabaseProvider;

  const config = loadConfig();
  const provider = await createProvider(config);
  let appliedBefore = 0;
  try {
    appliedBefore = (await readAppliedMigrations(provider)).length;
    await ensureSchemaUpToDate(provider);
    const appliedAfter = (await readAppliedMigrations(provider)).length;
    process.stdout.write(
      `migrations applied: ${appliedAfter - appliedBefore} (${appliedBefore} → ${appliedAfter})\n`,
    );
    return { exitCode: 0, appliedBefore, appliedAfter };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`migration failed: ${message}\n`);
    return { exitCode: 1, appliedBefore, appliedAfter: appliedBefore, reason: message };
  } finally {
    await provider.close().catch(() => {});
  }
}

function main(argv: string[]): void {
  void runMigrateCli(argv).then((result) => {
    process.exitCode = result.exitCode;
  });
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main(process.argv.slice(2));
}
