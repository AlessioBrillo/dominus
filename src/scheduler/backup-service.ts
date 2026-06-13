import { mkdirSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type Database from 'better-sqlite3';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface BackupResult {
  path: string;
  sizeBytes: number;
  durationMs: number;
}

export interface BackupServiceOptions {
  db: Database.Database;
  dbPath: string;
  backupDir: string;
  retentionDays: number;
}

export class BackupService {
  readonly #db: Database.Database;
  readonly #backupDir: string;
  readonly #retentionDays: number;

  constructor(options: BackupServiceOptions) {
    this.#db = options.db;
    this.#backupDir = resolve(options.backupDir);
    this.#retentionDays = options.retentionDays;
  }

  async create(): Promise<BackupResult> {
    const start = Date.now();

    if (!existsSync(this.#backupDir)) {
      mkdirSync(this.#backupDir, { recursive: true });
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const timestamp = Date.now();
    const fileName = `dominus-${dateStr}-${timestamp}.db`;
    const absPath = join(this.#backupDir, fileName);

    this.#db.pragma('wal_checkpoint(TRUNCATE)');
    this.#db.exec(`VACUUM INTO '${absPath.replace(/'/g, "''")}'`);

    const stat = statSync(absPath);
    const durationMs = Date.now() - start;

    logger.info({ path: absPath, sizeBytes: stat.size, durationMs }, 'Database backup created');

    return { path: absPath, sizeBytes: stat.size, durationMs };
  }

  prune(): number {
    if (!existsSync(this.#backupDir)) return 0;

    const cutoff = Date.now() - this.#retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const entry of readdirSync(this.#backupDir)) {
      if (!entry.endsWith('.db')) continue;
      const absPath = join(this.#backupDir, entry);
      try {
        const mtime = statSync(absPath).mtimeMs;
        if (mtime < cutoff) {
          rmSync(absPath);
          removed++;
          logger.debug({ path: absPath }, 'Pruned expired backup');
        }
      } catch {
        continue;
      }
    }

    if (removed > 0) {
      logger.info({ removed, backupDir: this.#backupDir }, 'Pruned expired backups');
    }
    return removed;
  }

  list(): Array<{ path: string; sizeBytes: number; createdAt: Date }> {
    if (!existsSync(this.#backupDir)) return [];

    const results: Array<{ path: string; sizeBytes: number; createdAt: Date }> = [];
    for (const entry of readdirSync(this.#backupDir)) {
      if (!entry.endsWith('.db')) continue;
      const absPath = join(this.#backupDir, entry);
      try {
        const stat = statSync(absPath);
        results.push({ path: absPath, sizeBytes: stat.size, createdAt: stat.mtime });
      } catch {
        continue;
      }
    }
    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return results;
  }
}
