import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { BackupService } from '../backup-service.js';

const TEST_DIR = resolve('./data/tmp/backup-test');
const TEST_DB_PATH = join(TEST_DIR, 'test.db');
const TEST_BACKUP_DIR = join(TEST_DIR, 'backups');

function createTestDb(): Database.Database {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
  const db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, value TEXT);
    INSERT INTO test (value) VALUES ('hello'), ('world');
  `);
  return db;
}

describe('BackupService', () => {
  let db: Database.Database;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('creates a backup file via VACUUM INTO', async () => {
    const service = new BackupService({
      db,
      dbPath: TEST_DB_PATH,
      backupDir: TEST_BACKUP_DIR,
      retentionDays: 30,
    });

    const result = await service.create();

    expect(existsSync(result.path)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.path).toMatch(/dominus-\d{4}-\d{2}-\d{2}-\d+\.db$/);

    const backupDb = new Database(result.path);
    const row = backupDb.prepare('SELECT value FROM test WHERE id = ?').get(1) as { value: string };
    expect(row.value).toBe('hello');
    backupDb.close();
  });

  it('lists backups in reverse chronological order', async () => {
    const service = new BackupService({
      db,
      dbPath: TEST_DB_PATH,
      backupDir: TEST_BACKUP_DIR,
      retentionDays: 30,
    });

    await service.create();
    await new Promise((r) => setTimeout(r, 10));
    await service.create();

    const list = service.list();
    expect(list).toHaveLength(2);
    const first = list[0]!;
    const second = list[1]!;
    expect(first.createdAt.getTime()).toBeGreaterThanOrEqual(second.createdAt.getTime());
  });

  it('prunes backups older than retention days', async () => {
    const service = new BackupService({
      db,
      dbPath: TEST_DB_PATH,
      backupDir: TEST_BACKUP_DIR,
      retentionDays: 0,
    });

    await service.create();
    expect(service.list().length).toBe(1);

    const pruned = service.prune();
    expect(pruned).toBe(1);
    expect(service.list().length).toBe(0);
  });

  it('returns empty list when backup dir does not exist', () => {
    const service = new BackupService({
      db,
      dbPath: TEST_DB_PATH,
      backupDir: join(TEST_DIR, 'nonexistent'),
      retentionDays: 30,
    });

    expect(service.list()).toEqual([]);
    expect(service.prune()).toBe(0);
  });

  it('skips non-db files in backup dir', async () => {
    mkdirSync(TEST_BACKUP_DIR, { recursive: true });

    const service = new BackupService({
      db,
      dbPath: TEST_DB_PATH,
      backupDir: TEST_BACKUP_DIR,
      retentionDays: 30,
    });

    const result = await service.create();
    const list = service.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.path).toBe(result.path);
  });

  it('handles backup when db has no WAL pages', async () => {
    db.pragma('wal_checkpoint(TRUNCATE)');
    const service = new BackupService({
      db,
      dbPath: TEST_DB_PATH,
      backupDir: TEST_BACKUP_DIR,
      retentionDays: 30,
    });

    const result = await service.create();
    expect(existsSync(result.path)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });
});
