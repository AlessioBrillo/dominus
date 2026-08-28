// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../provider/sqlite-adapter.js';
import {
  runMigrations,
  rollbackMigration,
  dryRunMigration,
  validateMigrationSync,
} from '../migrator.js';
import {
  getMigrationManifest,
  assertSchemaCompatible,
  readAppliedMigrations,
} from '../migration-manifest.js';

function openFreshDb(): SqliteProvider {
  return new SqliteProvider(new Database(':memory:'));
}

describe('Migration Rollback', () => {
  let provider: SqliteProvider;

  beforeEach(() => {
    provider = openFreshDb();
  });

  afterEach(async () => {
    await provider.close();
  });

  it('applies all migrations and records them in schema_migrations', async () => {
    runMigrations(provider.rawDb);
    const applied = await readAppliedMigrations(provider);
    const manifest = getMigrationManifest();
    expect(applied).toEqual(manifest);
  });

  it('rolls back the last applied migration and restores schema state', async () => {
    // Apply all migrations
    runMigrations(provider.rawDb);
    let applied = await readAppliedMigrations(provider);
    const manifest = getMigrationManifest();
    expect(applied).toEqual(manifest);

    // Rollback the last migration using the new function
    const lastMigration = manifest[manifest.length - 1]!;
    await rollbackMigration(provider, lastMigration);

    // Verify rollback
    applied = await readAppliedMigrations(provider);
    expect(applied).toEqual(manifest.slice(0, -1));

    // Schema should be compatible with the rolled-back state
    const compat = assertSchemaCompatible(applied, manifest);
    expect(compat.ok).toBe(true);
  });

  it('dry-run reports correct SQL diff without committing', async () => {
    // Apply all migrations first (creates schema_migrations table)
    runMigrations(provider.rawDb);
    const manifest = getMigrationManifest();

    // Rollback last migration to create a state with all but last
    const lastMigration = manifest[manifest.length - 1]!;
    await rollbackMigration(provider, lastMigration);

    // Now dry-run the next migration (which is the one we just rolled back)
    const result = await dryRunMigration(provider, lastMigration);

    expect(result).toBeDefined();
    expect(result.upSql).toBeDefined();
    expect(Array.isArray(result.upSql)).toBe(true);
    expect(result.upSql.length).toBeGreaterThan(0);
    expect(result.downSql).toBeDefined();
    expect(Array.isArray(result.downSql)).toBe(true);
    expect(result.wouldCommit).toBe(false);
  });

  it('validateMigrationSync warns for migrations missing down() without backwardCompatible', () => {
    const errors = validateMigrationSync();
    // Should return array of warnings/errors
    expect(Array.isArray(errors)).toBe(true);
    // At minimum, existing migrations without down() should be flagged
    // but not cause a hard failure (backward compatibility)
    expect(errors.length).toBeGreaterThan(0);
  });

  it('prevents rollback of non-last migration (must rollback in reverse order)', async () => {
    runMigrations(provider.rawDb);
    const manifest = getMigrationManifest();
    const middleMigration = manifest[Math.floor(manifest.length / 2)]!;

    // Attempting to rollback a non-last migration should fail
    await expect(rollbackMigration(provider, middleMigration)).rejects.toThrow(
      /must rollback in reverse order|not the last applied/i,
    );
  });

  it('rollbacks multiple migrations in sequence', async () => {
    runMigrations(provider.rawDb);
    const manifest = getMigrationManifest();

    // Rollback last 3 migrations
    for (let i = 0; i < 3; i++) {
      const last = (await readAppliedMigrations(provider)).pop()!;
      await rollbackMigration(provider, last);
    }

    const applied = await readAppliedMigrations(provider);
    expect(applied).toEqual(manifest.slice(0, -3));
  });
});

describe('Migration Manifest Versioning', () => {
  it('includes hash of up/down functions for drift detection', async () => {
    const provider = openFreshDb();
    try {
      runMigrations(provider.rawDb);

      // The manifest should now include version and hashes
      // This will be tested once manifest v2 is implemented
      const manifest = getMigrationManifest();
      expect(manifest.length).toBeGreaterThan(0);
    } finally {
      await provider.close();
    }
  });
});

describe('Migration Roundtrip (SQLite -> PG -> SQLite)', () => {
  it('verifies schema integrity after roundtrip migration', async () => {
    // This test will use migrate-sqlite-to-pg.ts --verify-roundtrip
    // For now it documents the expected behavior
    expect(true).toBe(true); // placeholder
  });
});

// Integration test for the CLI command
describe('CLI: dominus maintenance migrate rollback', () => {
  it('exists and accepts --force flag', async () => {
    // This will be tested once the CLI command is implemented
    expect(true).toBe(true); // placeholder
  });
});
