// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';
import { sqlTimestamp } from '../sql-timestamp.js';

export interface ProviderCacheRow {
  id: number;
  cache_key: string;
  provider_name: string;
  value: string;
  created_at: string;
  expires_at: string;
}

export class ProviderCacheRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async get(cacheKey: string, providerName: string): Promise<string | null> {
    const row = await this.db.queryOne<{ value: string }>(
      `SELECT value FROM provider_cache
       WHERE cache_key = ? AND provider_name = ? AND expires_at > CURRENT_TIMESTAMP
       ORDER BY created_at DESC LIMIT 1`,
      [cacheKey, providerName],
    );
    return row?.value ?? null;
  }

  async set(cacheKey: string, providerName: string, value: string, ttlDays: number): Promise<void> {
    const expiresAt = sqlTimestamp(new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000));
    await this.db.exec(
      `INSERT INTO provider_cache (cache_key, provider_name, value, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(cache_key, provider_name) DO UPDATE SET
         value = excluded.value,
         expires_at = excluded.expires_at,
         created_at = CURRENT_TIMESTAMP`,
      [cacheKey, providerName, value, expiresAt],
    );
  }

  async pruneExpired(): Promise<number> {
    const result = await this.db.exec(`DELETE FROM provider_cache WHERE expires_at < ?`, [
      sqlTimestamp(),
    ]);
    return Number(result.changes);
  }

  async count(): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM provider_cache');
    return row!.n;
  }

  /** Delete all cache entries for a specific provider (ADR-0078).
   *  Used when DNSSEC validation is lost — purge all potentially corrupted entries. */
  async clearProvider(providerName: string): Promise<number> {
    const result = await this.db.exec('DELETE FROM provider_cache WHERE provider_name = ?', [
      providerName,
    ]);
    return Number(result.changes);
  }

  /** Delete all cache entries matching a key prefix.
   *  Used for cross-process cache invalidation when a provider's data changes.
   *  Returns the number of deleted entries. */
  async invalidatePrefix(prefix: string): Promise<number> {
    const result = await this.db.exec('DELETE FROM provider_cache WHERE cache_key LIKE ?', [
      `${prefix}%`,
    ]);
    return Number(result.changes);
  }
}
