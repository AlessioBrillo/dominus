// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../config.js';
import type { DatabaseProvider } from '../provider/interface.js';
import { SqliteProvider } from '../provider/sqlite-adapter.js';
import { MockDatabaseProvider } from '../provider/mock-adapter.js';
import { getMigrationManifest } from '../migration-manifest.js';
import { runMigrateCli, type MigrateCliDeps } from '../migrate-cli.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function captureStdout(): (text: string) => boolean {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

function captureStderr(): (text: string) => boolean {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

function makeDeps(
  provider: DatabaseProvider,
  overrides: Partial<MigrateCliDeps> = {},
): MigrateCliDeps {
  return {
    loadConfig: () => ({ DATABASE_URL: undefined }) as unknown as Config,
    createProvider: async () => provider,
    ...overrides,
  };
}

describe('runMigrateCli — usage', () => {
  it('prints usage and exits 0 on --help', async () => {
    const write = captureStdout();
    const result = await runMigrateCli(['--help'], makeDeps(new MockDatabaseProvider()));
    expect(result.exitCode).toBe(0);
    const output = (write as ReturnType<typeof vi.fn>).mock.calls.join('');
    expect(output).toContain('Usage');
  });

  it('rejects unknown arguments with exit code 2', async () => {
    captureStderr();
    const result = await runMigrateCli(['--bogus'], makeDeps(new MockDatabaseProvider()));
    expect(result.exitCode).toBe(2);
    expect(result.reason).toContain('--bogus');
  });
});

describe('runMigrateCli — happy path', () => {
  it('applies all pending migrations on a fresh database and reports counts', async () => {
    const write = captureStdout();
    const provider = SqliteProvider.openInMemory();
    try {
      const result = await runMigrateCli([], makeDeps(provider));
      expect(result.exitCode).toBe(0);
      expect(result.appliedBefore).toBe(0);
      expect(result.appliedAfter).toBe(getMigrationManifest().length);
      const output = (write as ReturnType<typeof vi.fn>).mock.calls.join('');
      expect(output).toContain(`migrations applied: ${getMigrationManifest().length}`);
    } finally {
      await provider.close();
    }
  });

  it('is idempotent — a second run against the same database applies nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dominus-migrate-'));
    const dbPath = join(dir, 'dominus.db');
    try {
      const first = await runMigrateCli([], makeDeps(SqliteProvider.create(dbPath)));
      expect(first.exitCode).toBe(0);
      expect(first.appliedAfter).toBe(getMigrationManifest().length);

      const second = await runMigrateCli([], makeDeps(SqliteProvider.create(dbPath)));
      expect(second.exitCode).toBe(0);
      expect(second.appliedBefore).toBe(getMigrationManifest().length);
      expect(second.appliedAfter).toBe(getMigrationManifest().length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes the provider after a successful run', async () => {
    const provider = SqliteProvider.openInMemory();
    const result = await runMigrateCli([], makeDeps(provider));
    expect(result.exitCode).toBe(0);
    expect(provider.isOpen()).toBe(false);
  });
});

describe('runMigrateCli — schema gate', () => {
  class ForeignSchemaProvider extends MockDatabaseProvider {
    override async query<T>(sql: string): Promise<T[]> {
      if (sql.includes('schema_migrations')) {
        return [{ migration_name: '9999_foreign' }] as T[];
      }
      return super.query(sql);
    }
  }

  it('refuses to migrate a database whose applied set the image does not know', async () => {
    captureStderr();
    const provider = new ForeignSchemaProvider('postgres');
    const result = await runMigrateCli([], makeDeps(provider));
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain('gate failed');
    expect(provider.calls.some((c) => c.method === 'runMigrations')).toBe(false);
    expect(provider.isOpen()).toBe(false);
  });
});

describe('runMigrateCli — failure handling', () => {
  class ThrowingProvider extends MockDatabaseProvider {
    override async runMigrations(): Promise<void> {
      throw new Error('disk full');
    }
  }

  it('reports migration failures with exit code 1 and a reason', async () => {
    captureStderr();
    const provider = new ThrowingProvider();
    const result = await runMigrateCli([], makeDeps(provider));
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain('disk full');
    expect(provider.isOpen()).toBe(false);
  });

  it('passes the loaded config to the provider factory', async () => {
    const loadConfig = vi.fn(() => ({ DATABASE_URL: 'postgres://ci' }) as unknown as Config);
    const createProvider = vi.fn(async () => new MockDatabaseProvider('postgres'));
    const result = await runMigrateCli([], { loadConfig, createProvider });
    expect(result.exitCode).toBe(0);
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ DATABASE_URL: 'postgres://ci' }),
    );
  });
});
