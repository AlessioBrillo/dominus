import type Database from 'better-sqlite3';

export interface ProviderCacheRow {
  id: number;
  cache_key: string;
  provider_name: string;
  value: string;
  created_at: string;
  expires_at: string;
}

export class ProviderCacheRepository {
  constructor(private readonly db: Database.Database) {}

  get(cacheKey: string, providerName: string): string | null {
    const row = this.db
      .prepare(
        `SELECT value FROM provider_cache
         WHERE cache_key = ? AND provider_name = ? AND expires_at > datetime('now')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(cacheKey, providerName) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(cacheKey: string, providerName: string, value: string, ttlDays: number): void {
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO provider_cache (cache_key, provider_name, value, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(cacheKey, providerName, value, expiresAt);
  }

  pruneExpired(): number {
    const result = this.db
      .prepare(`DELETE FROM provider_cache WHERE expires_at < datetime('now')`)
      .run();
    return Number(result.changes);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM provider_cache').get() as { n: number };
    return row.n;
  }
}
