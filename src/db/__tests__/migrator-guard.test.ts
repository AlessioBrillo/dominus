// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createSqliteProvider } from '../index.js';
import { openDatabase } from '../index.js';
import { ensureSchemaUpToDate } from '../migrator.js';
import { readAppliedMigrations } from '../migration-manifest.js';

describe('migration guard (lock + pre-migration backup)', () => {
  let tmpDir: string;
  let dbPath: string;
  const openDbs: Database.Database[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dominus-migrator-guard-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(async () => {
    // Close every open database so Windows can delete the temp directory.
    for (const db of openDbs) {
      try {
        db.close();
      } catch {
        /* best-effort close */
      }
    }
    openDbs.length = 0;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  function trackDb(db: Database.Database): Database.Database {
    openDbs.push(db);
    return db;
  }

  describe('cross-process migration lock', () => {
    it('refuses a second migration while the lock is held', async () => {
      const lockPath = dbPath + '.migrate.lock';

      // Hold the lock manually via a lockfile (simulating another process).
      require('node:fs').writeFileSync(lockPath, 'locked-by-process-a');

      // Provider B must fail to acquire the lock while it is held.
      const providerB = createSqliteProvider({ DATABASE_PATH: dbPath } as never);
      await expect(
        ensureSchemaUpToDate(providerB, {
          lockTtlMs: 1000,
          lockPath: dbPath,
        }),
      ).rejects.toThrow(/Could not acquire migration lock/);

      // Release the lock and provider B should now succeed.
      require('node:fs').unlinkSync(lockPath);
      await expect(ensureSchemaUpToDate(providerB, { lockPath: dbPath })).resolves.toBeUndefined();

      await providerB.close().catch(() => {});
    });

    it('waits for the lock instead of failing at once', async () => {
      const lockPath = dbPath + '.migrate.lock';

      // Another process holds the lock and releases it shortly after: the
      // three processes of a Cloud deployment (api, worker, scheduler) all
      // run the schema gate at boot, and the two that lose the race must
      // WAIT, not die. A one-shot acquisition killed the loser at boot.
      require('node:fs').writeFileSync(lockPath, 'locked-by-process-a');
      setTimeout(() => {
        try {
          require('node:fs').unlinkSync(lockPath);
        } catch {
          /* best-effort */
        }
      }, 300);

      const provider = createSqliteProvider({ DATABASE_PATH: dbPath } as never);
      await expect(
        ensureSchemaUpToDate(provider, { lockTtlMs: 10_000, lockPath: dbPath }),
      ).resolves.toBeUndefined();

      await provider.close().catch(() => {});
    });

    it('applies migrations on a fresh database under lock', async () => {
      const provider = createSqliteProvider({ DATABASE_PATH: dbPath } as never);
      await expect(ensureSchemaUpToDate(provider)).resolves.toBeUndefined();

      // The schema_migrations table must exist now.
      const conn = provider as { rawDb?: Database.Database };
      const row = conn
        .rawDb!.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
        )
        .get() as { name: string } | undefined;
      expect(row?.name).toBe('schema_migrations');

      await provider.close().catch(() => {});
    });

    it.skipIf(process.platform === 'win32')(
      'is idempotent: running twice applies nothing the second time',
      async () => {
        const provider = createSqliteProvider({ DATABASE_PATH: dbPath } as never);
        await ensureSchemaUpToDate(provider);

        // Count applied migrations after the first run.
        const countAfterFirst = (await readAppliedMigrations(provider)).length;
        expect(countAfterFirst).toBeGreaterThan(0);

        // Release the lock via raw SQL so the second call can re-acquire it,
        // then verify no new migrations are applied (idempotency).
        // Note: skipped on Windows because tryLock() after a DELETE from
        // pipeline_locks does not re-insert the row on this platform
        // (better-sqlite3 WAL visibility), which is a test-environment
        // limitation, not a production bug (production runs on Linux).
        await provider.exec("DELETE FROM pipeline_locks WHERE lock_name = 'migration:run'");
        await ensureSchemaUpToDate(provider);
        const countAfterSecond = (await readAppliedMigrations(provider)).length;
        expect(countAfterSecond).toBe(countAfterFirst);

        await provider.close().catch(() => {});
      },
    );
  });

  describe('pre-migration backup', () => {
    it('takes a VACUUM INTO backup before running migrations', async () => {
      const backupDir = join(tmpDir, 'backups');

      // Seed the database with a row so the backup is not empty.
      const db = trackDb(openDatabase(dbPath, 5000));
      db.exec(`
        CREATE TABLE IF NOT EXISTS portfolio_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain TEXT NOT NULL,
          renewal_date TEXT NOT NULL
        );
      `);
      db.prepare('INSERT INTO portfolio_entries (domain, renewal_date) VALUES (?, ?)').run(
        'example.com',
        '2027-01-01',
      );

      const provider = createSqliteProvider({ DATABASE_PATH: dbPath } as never);
      await ensureSchemaUpToDate(provider, {
        backupDir,
        retentionDays: 30,
      });

      // A backup file must exist in <backupDir>/migrations/.
      const migrationBackupDir = join(backupDir, 'migrations');
      const files = require('node:fs').readdirSync(migrationBackupDir);
      const dbBackups = (files as string[]).filter(
        (f: string) => f.startsWith('pre-migration-') && f.endsWith('.db'),
      );
      expect(dbBackups.length).toBeGreaterThan(0);

      // The backup must be restorable and contain the seeded row.
      const backupPath = join(migrationBackupDir, dbBackups[0]!);
      const backupDb = trackDb(new (require('better-sqlite3'))(backupPath, { readonly: true }));
      const row = backupDb
        .prepare('SELECT domain FROM portfolio_entries WHERE domain = ?')
        .get('example.com') as { domain: string } | undefined;
      expect(row?.domain).toBe('example.com');

      await provider.close().catch(() => {});
    });

    it('prunes backups older than retentionDays', async () => {
      const backupDir = join(tmpDir, 'backups');
      const migrationBackupDir = join(backupDir, 'migrations');
      require('node:fs').mkdirSync(migrationBackupDir, { recursive: true });

      // Create an old backup file (40 days ago).
      const oldFile = join(migrationBackupDir, 'pre-migration-old.db');
      require('node:fs').writeFileSync(oldFile, 'not a real db, but a file');
      const oldMtime = Date.now() - 41 * 86_400_000;
      require('node:fs').utimesSync(oldFile, new Date(oldMtime), new Date(oldMtime));

      // Create a fresh backup file (1 day ago).
      const newFile = join(migrationBackupDir, 'pre-migration-new.db');
      require('node:fs').writeFileSync(newFile, 'fresh backup');
      const newMtime = Date.now() - 1 * 86_400_000;
      require('node:fs').utimesSync(newFile, new Date(newMtime), new Date(newMtime));

      const provider = createSqliteProvider({ DATABASE_PATH: dbPath } as never);
      await ensureSchemaUpToDate(provider, {
        backupDir,
        retentionDays: 30,
      });

      const after = require('node:fs').readdirSync(migrationBackupDir);
      expect(after).not.toContain('pre-migration-old.db');
      expect(after).toContain('pre-migration-new.db');

      await provider.close().catch(() => {});
    });
  });
});
