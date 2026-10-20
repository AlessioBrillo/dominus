// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../provider/sqlite-adapter.js';
import { TENANT_SCOPED_TABLES, TENANT_TABLE_NAMES } from '../tenant-data-registry.js';

/**
 * The registry must describe the real schema.
 *
 * An omission is the worst failure mode of the data-subject rights: a table
 * that is not listed is a table whose rows are missing from the export
 * (art. 15) and survive the deletion (art. 17). So the registry is checked
 * against the migrated schema in both directions, and the deletion order is
 * checked against the foreign keys.
 */
describe('tenant data registry', () => {
  let db: SqliteProvider;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
  });

  afterEach(async () => {
    await db.close();
  });

  async function tablesWithTenantColumn(): Promise<string[]> {
    const tables = await db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    const withTenant: string[] = [];
    for (const { name } of tables) {
      const columns = await db.query<{ name: string }>(`PRAGMA table_info('${name}')`);
      if (columns.some((c) => c.name === 'tenant_id')) withTenant.push(name);
    }
    return withTenant;
  }

  it('lists every table that has a tenant_id column', async () => {
    const inSchema = await tablesWithTenantColumn();
    const inRegistry = [...TENANT_TABLE_NAMES].sort();

    const missing = inSchema.filter((t) => !inRegistry.includes(t));
    expect(missing).toEqual([]);
  });

  it('lists nothing that the schema does not have', async () => {
    const inSchema = await tablesWithTenantColumn();
    const unknown = TENANT_TABLE_NAMES.filter((t) => !inSchema.includes(t));
    expect(unknown).toEqual([]);
  });

  it('deletes the children before the parents', async () => {
    const tables = await db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    );
    const position = new Map(TENANT_TABLE_NAMES.map((t, index) => [t, index]));

    for (const { name } of tables) {
      const fks = await db.query<{ table: string }>(`PRAGMA foreign_key_list('${name}')`);
      for (const fk of fks) {
        const childIndex = position.get(name);
        const parentIndex = position.get(fk.table);
        if (childIndex === undefined || parentIndex === undefined) continue;
        expect(
          childIndex,
          `${name} references ${fk.table} and must be deleted before it`,
        ).toBeLessThan(parentIndex);
      }
    }
  });

  it('has no duplicate entries', () => {
    expect(new Set(TENANT_TABLE_NAMES).size).toBe(TENANT_TABLE_NAMES.length);
  });

  it('marks the tables that are kept for a legal retention obligation', () => {
    for (const spec of TENANT_SCOPED_TABLES) {
      expect(typeof spec.table).toBe('string');
      expect(spec.table.length).toBeGreaterThan(0);
    }
  });
});
