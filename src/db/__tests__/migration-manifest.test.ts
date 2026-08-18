// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrator.js';
import { SqliteProvider } from '../provider/sqlite-adapter.js';
import { getMigrationNames } from '../migrations/registry.js';
import {
  getMigrationManifest,
  assertSchemaCompatible,
  readAppliedMigrations,
  type SchemaCompatibility,
} from '../migration-manifest.js';

function openFreshDb(): SqliteProvider {
  return new SqliteProvider(new Database(':memory:'));
}

describe('getMigrationManifest', () => {
  it('returns the ordered migration names from the registry', () => {
    const manifest = getMigrationManifest();
    expect(manifest.length).toBeGreaterThan(0);
    expect(manifest).toEqual(getMigrationNames());
  });

  it('returns a strictly ordered, duplicate-free list', () => {
    const manifest = getMigrationManifest();
    const sorted = [...manifest].sort();
    expect(manifest).toEqual(sorted);
    expect(new Set(manifest).size).toBe(manifest.length);
  });
});

describe('assertSchemaCompatible', () => {
  const manifest = ['0001_a', '0002_b', '0003_c'];

  it('accepts an empty applied set (fresh database)', () => {
    expect(assertSchemaCompatible([], manifest).ok).toBe(true);
  });

  it('accepts an applied set that is a prefix of the manifest', () => {
    expect(assertSchemaCompatible(['0001_a', '0002_b'], manifest).ok).toBe(true);
    expect(assertSchemaCompatible(manifest, manifest).ok).toBe(true);
  });

  it('rejects applied migrations the manifest does not know (downgrade or foreign schema)', () => {
    const result = assertSchemaCompatible(['0001_a', '0009_z'], manifest);
    expect(result.ok).toBe(false);
    expect(result.unknown).toEqual(['0009_z']);
  });

  it('rejects an applied set that is ahead of the manifest (downgrade deploy)', () => {
    const result = assertSchemaCompatible([...manifest, '0004_d'], manifest);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ahead');
  });

  it('rejects reordered migrations (out-of-order applied set)', () => {
    const result = assertSchemaCompatible(['0002_b', '0001_a'], manifest);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('order');
  });

  it('produces a single unknown list without duplicates', () => {
    const result = assertSchemaCompatible(['0009_z', '0009_z'], manifest);
    expect(result.unknown).toEqual(['0009_z']);
  });
});

describe('readAppliedMigrations', () => {
  it('returns an empty list when the migrations table does not exist yet', async () => {
    const provider = openFreshDb();
    try {
      await expect(readAppliedMigrations(provider)).resolves.toEqual([]);
    } finally {
      await provider.close();
    }
  });

  it('returns the applied migrations in application order after a full migration run', async () => {
    const provider = openFreshDb();
    try {
      runMigrations(provider.rawDb);
      const applied = await readAppliedMigrations(provider);
      expect(applied).toEqual(getMigrationManifest());
    } finally {
      await provider.close();
    }
  });

  it('reflects partial application (stop after the first migration)', async () => {
    const provider = openFreshDb();
    try {
      provider.rawDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          migration_name TEXT NOT NULL UNIQUE,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      const [first] = getMigrationManifest();
      provider.rawDb
        .prepare('INSERT INTO schema_migrations (migration_name) VALUES (?)')
        .run(first);
      const applied = await readAppliedMigrations(provider);
      expect(applied).toEqual([first]);
    } finally {
      await provider.close();
    }
  });

  it('resolves compatibly against a partially applied database', async () => {
    const provider = openFreshDb();
    try {
      provider.rawDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          migration_name TEXT NOT NULL UNIQUE,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      const manifest = getMigrationManifest();
      for (const name of manifest.slice(0, 5)) {
        provider.rawDb
          .prepare('INSERT INTO schema_migrations (migration_name) VALUES (?)')
          .run(name);
      }
      const applied = await readAppliedMigrations(provider);
      const compat: SchemaCompatibility = assertSchemaCompatible(applied, manifest);
      expect(compat.ok).toBe(true);
    } finally {
      await provider.close();
    }
  });
});
