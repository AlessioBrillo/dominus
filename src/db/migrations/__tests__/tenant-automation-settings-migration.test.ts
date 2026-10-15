// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { TenantAutomationSettingsRepository } from '../../repositories/tenant-automation-settings-repository.js';
import { getMigrations } from '../registry.js';

/**
 * Runs migration 0063 against a real in-memory SQLite database and
 * exercises the repository on the resulting schema. Guards the migration
 * SQL itself and the conservative defaults: a tenant is opted out until
 * it says otherwise.
 */
describe('Tenant automation settings migration (0063)', () => {
  it('creates the table with conservative defaults and supports the repository contract', async () => {
    const db = new Database(':memory:');
    const migrations = getMigrations().filter(
      (m) => m.name === '0063_create_tenant_automation_settings',
    );
    expect(migrations).toHaveLength(1);
    for (const migration of migrations) {
      migration.up(db);
    }

    const provider = new SqliteProvider(db);
    const repo = new TenantAutomationSettingsRepository(provider);

    // Absent row -> conservative defaults (opted out, dry-run).
    expect(await repo.get()).toEqual({ enabled: false, dryRun: true });

    // Partial update merges into the current settings.
    const afterEnable = await repo.set({ enabled: true });
    expect(afterEnable).toEqual({ enabled: true, dryRun: true });
    expect(await repo.get()).toEqual({ enabled: true, dryRun: true });

    const afterLive = await repo.set({ dryRun: false });
    expect(afterLive).toEqual({ enabled: true, dryRun: false });
    expect(await repo.get()).toEqual({ enabled: true, dryRun: false });

    // Disabling keeps the dry-run preference (no silent reset).
    const afterDisable = await repo.set({ enabled: false });
    expect(afterDisable).toEqual({ enabled: false, dryRun: false });

    // Repeated writes upsert the same row instead of duplicating it.
    await repo.set({ enabled: true });
    const count = db.prepare('SELECT COUNT(*) AS n FROM tenant_automation_settings').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });
});
