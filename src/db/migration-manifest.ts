// SPDX-License-Identifier: AGPL-3.0-only
// Schema migration manifest — the single source of truth for the
// "is this image allowed to boot against this database" check.
//
// Every image ships its own ordered migration list (compiled from the
// registry). At boot and at deploy time the applied set from the database
// is compared against the image's manifest: it must be a PREFIX of the
// manifest. Anything else means one of:
//   - the image is older than the schema (downgrade deploy / auto-rollback
//     onto a migrated database) — the old code would run against a schema
//     it does not understand;
//   - the applied set contains migrations this image does not know
//     (divergent lineage or manual intervention) — same hazard.
// Both cases fail closed: refuse to boot, refuse to roll back, restore
// from a backup instead (see docs/releases/migration-policy.md).
import type { DatabaseProvider } from './provider/interface.js';
import { getMigrationNames, getMigrations } from './migrations/registry.js';
import { createHash } from 'node:crypto';

/** Manifest version — increment when the manifest structure changes. */
export const MANIFEST_VERSION = 2;

/** Content hash of a migration's up/down functions for drift detection. */
export function hashMigrationSource(migration: {
  name: string;
  up: Function;
  down?: Function;
  upPg?: Function;
}): string {
  const source = [
    migration.name,
    migration.up.toString(),
    migration.down?.toString() ?? '',
    migration.upPg?.toString() ?? '',
  ].join('|');
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

export interface MigrationManifestEntry {
  name: string;
  hash: string;
}

export interface SchemaCompatibility {
  ok: boolean;
  /** Migrations applied in the database that the manifest does not know. */
  unknown: string[];
  /** Human-readable reason when !ok. */
  reason?: string;
}

/** The ordered migration names this build knows (v1 compat). */
export function getMigrationManifest(): string[] {
  return getMigrationNames();
}

/** The full manifest with version and content hashes (v2). */
export function getMigrationManifestV2(): MigrationManifestEntry[] {
  const migrations = getMigrations();
  return migrations.map((m) => ({
    name: m.name,
    hash: hashMigrationSource(m),
  }));
}

/** Get the manifest as a versioned object for serialization. */
export function getVersionedManifest(): { version: number; migrations: MigrationManifestEntry[] } {
  return {
    version: MANIFEST_VERSION,
    migrations: getMigrationManifestV2(),
  };
}

/**
 * Fail-closed schema compatibility check.
 *
 * `applied` must be a prefix of `manifest` (same order, no extras).
 * Empty applied (fresh database) is always compatible.
 */
export function assertSchemaCompatible(applied: string[], manifest: string[]): SchemaCompatibility {
  if (applied.length === 0) return { ok: true, unknown: [] };

  const manifestSet = new Set(manifest);
  const unknown = [...new Set(applied.filter((name) => !manifestSet.has(name)))];

  if (applied.length > manifest.length) {
    return {
      ok: false,
      unknown,
      reason:
        `database schema is ahead of this image: ${applied.length} migrations ` +
        `applied but this image knows ${manifest.length}. This is a downgrade ` +
        `deploy or a rollback onto a migrated schema — booting would run old ` +
        `code against an unknown schema. Restore from a PITR backup instead.`,
    };
  }

  if (unknown.length > 0) {
    return {
      ok: false,
      unknown,
      reason:
        `database contains migrations this image does not know: ` +
        `${unknown.join(', ')}. The schema does not come from this release ` +
        `lineage — refusing to boot.`,
    };
  }

  for (let i = 0; i < applied.length; i++) {
    if (applied[i] !== manifest[i]) {
      return {
        ok: false,
        unknown,
        reason:
          `applied migration order diverges from the manifest at index ${i}: ` +
          `database has '${applied[i]}', this image expects '${manifest[i]}'. ` +
          `The schema_migrations table must be a strict prefix of the manifest.`,
      };
    }
  }

  return { ok: true, unknown };
}

/**
 * Read the applied migration names from a live database, in application
 * order. A database that has never migrated (no schema_migrations table)
 * yields an empty list — that is the compatible "fresh" state.
 */
export async function readAppliedMigrations(provider: DatabaseProvider): Promise<string[]> {
  try {
    const rows = await provider.query<{ migration_name: string }>(
      'SELECT migration_name FROM schema_migrations ORDER BY id',
    );
    return rows.map((r) => r.migration_name);
  } catch {
    // Table missing = never migrated = fresh database. Anything else that
    // fails here is surfaced by runMigrations immediately afterwards.
    return [];
  }
}
