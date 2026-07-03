import type { DatabaseProvider } from '../provider/interface.js';

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
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');
    await this.db.exec(
      `INSERT OR REPLACE INTO provider_cache (cache_key, provider_name, value, expires_at)
       VALUES (?, ?, ?, ?)`,
      [cacheKey, providerName, value, expiresAt],
    );
  }

  async pruneExpired(): Promise<number> {
    const result = await this.db.exec(
      `DELETE FROM provider_cache WHERE expires_at < CURRENT_TIMESTAMP`,
    );
    return Number(result.changes);
  }

  async count(): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM provider_cache');
    return row!.n;
  }
}
