// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { DatabaseProvider } from '../db/provider/interface.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface BackupResult {
  path: string;
  sizeBytes: number;
  durationMs: number;
}

export interface BackupServiceOptions {
  provider: DatabaseProvider;
  backupDir: string;
  retentionDays: number;
  /**
   * Optional hook fired after a successful backup — used to record the
   * `dominus_backup_last_success_timestamp` gauge (BackupStale alert).
   */
  onSuccess?: () => void;
}

export class BackupService {
  readonly #provider: DatabaseProvider;
  readonly #backupDir: string;
  readonly #retentionDays: number;
  readonly #onSuccess: (() => void) | undefined;

  constructor(options: BackupServiceOptions) {
    this.#provider = options.provider;
    this.#backupDir = resolve(options.backupDir);
    this.#retentionDays = options.retentionDays;
    this.#onSuccess = options.onSuccess;
  }

  async create(): Promise<BackupResult> {
    const dateStr = new Date().toISOString().slice(0, 10);
    const timestamp = Date.now();
    const fileName = `dominus-${dateStr}-${timestamp}.db`;
    const absPath = join(this.#backupDir, fileName);

    const result = await this.#provider.backup(absPath);
    this.#onSuccess?.();
    return result;
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
