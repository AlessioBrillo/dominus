import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { ProviderCacheRepository } from '../../db/repositories/provider-cache-repository.js';
import { CachedProvider } from '../cached-provider.js';

interface TestData {
  id: number;
  name: string;
}

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  return db;
}

describe('CachedProvider', () => {
  let db: Database.Database;
  let repo: ProviderCacheRepository;

  beforeEach(() => {
    db = openTestDb();
    repo = new ProviderCacheRepository(db);
  });

  it('calls fetchFn on cache miss and returns result', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ id: 1, name: 'test' } satisfies TestData);
    const provider = new CachedProvider<TestData>(fetchFn, repo, 'test-provider', 7);

    const result = await provider.get('key1');

    expect(result).toEqual({ id: 1, name: 'test' });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledWith('key1');
  });

  it('writes to cache after fetchFn succeeds', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ id: 2, name: 'cached' } satisfies TestData);
    const provider = new CachedProvider<TestData>(fetchFn, repo, 'test-provider', 7);

    await provider.get('write-test');

    const cached = repo.get('write-test', 'test-provider');
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached!)).toEqual({ id: 2, name: 'cached' });
  });

  it('returns cached result and does NOT call fetchFn on cache hit', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ id: 3, name: 'hit' } satisfies TestData);
    const provider = new CachedProvider<TestData>(fetchFn, repo, 'test-provider', 7);

    await provider.get('hit-test');
    expect(fetchFn).toHaveBeenCalledOnce();

    const result = await provider.get('hit-test');
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(result).toEqual({ id: 3, name: 'hit' });
  });

  it('uses custom serializer when provided', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ id: 4, name: 'custom' } satisfies TestData);
    const serialize = vi.fn().mockReturnValue(JSON.stringify({ id: 4, name: 'custom' }));
    const deserialize = vi.fn().mockImplementation((raw: string) => JSON.parse(raw) as TestData);
    const provider = new CachedProvider<TestData>(fetchFn, repo, 'custom-serializer', 7, {
      serialize,
      deserialize,
    });

    const result = await provider.get('serialize-test');

    expect(result).toEqual({ id: 4, name: 'custom' });
    expect(serialize).toHaveBeenCalledOnce();
  });

  it('falls through to fetchFn when cache is corrupted', async () => {
    repo.set('corrupt-key', 'corrupt-provider', 'not-valid-json{{{', 7);

    const fetchFn = vi.fn().mockResolvedValue({ id: 5, name: 'recovered' } satisfies TestData);
    const provider = new CachedProvider<TestData>(fetchFn, repo, 'corrupt-provider', 7);

    const result = await provider.get('corrupt-key');

    expect(result).toEqual({ id: 5, name: 'recovered' });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('does NOT write to cache when fetchFn throws', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const provider = new CachedProvider<TestData>(fetchFn, repo, 'error-provider', 7);

    await expect(provider.get('error-key')).rejects.toThrow('fetch failed');

    const cached = repo.get('error-key', 'error-provider');
    expect(cached).toBeNull();
  });

  it('is provider-scoped: different providers do not collide', async () => {
    const fetchFnA = vi.fn().mockResolvedValue({ id: 10, name: 'provider-a' } satisfies TestData);
    const fetchFnB = vi.fn().mockResolvedValue({ id: 20, name: 'provider-b' } satisfies TestData);

    const providerA = new CachedProvider<TestData>(fetchFnA, repo, 'provider-a', 7);
    const providerB = new CachedProvider<TestData>(fetchFnB, repo, 'provider-b', 7);

    await providerA.get('same-key');
    await providerB.get('same-key');

    const resultA = await providerA.get('same-key');
    const resultB = await providerB.get('same-key');

    expect(resultA).toEqual({ id: 10, name: 'provider-a' });
    expect(resultB).toEqual({ id: 20, name: 'provider-b' });
    expect(fetchFnA).toHaveBeenCalledOnce();
    expect(fetchFnB).toHaveBeenCalledOnce();
  });

  it('re-fetches after cache entry expires', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({ id: 1, name: 'first' } satisfies TestData)
      .mockResolvedValueOnce({ id: 2, name: 'second' } satisfies TestData);

    const provider = new CachedProvider<TestData>(fetchFn, repo, 'ttl-provider', 7);

    const first = await provider.get('ttl-key');
    expect(first).toEqual({ id: 1, name: 'first' });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Manually set the cached entry's expires_at to the past
    const past = new Date(Date.now() - 86_400_000).toISOString();
    db.prepare(
      `UPDATE provider_cache SET expires_at = ? WHERE cache_key = ? AND provider_name = ?`,
    ).run(past, 'ttl-key', 'ttl-provider');

    // Cache entry is now expired — should re-fetch
    const second = await provider.get('ttl-key');
    expect(second).toEqual({ id: 2, name: 'second' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('returns stale cached data when cache is manually overwritten', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ id: 100, name: 'original' } satisfies TestData);
    const provider = new CachedProvider<TestData>(fetchFn, repo, 'overwrite', 1);

    await provider.get('overwrite-key');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Manually replace cached data with different content
    repo.set('overwrite-key', 'overwrite', JSON.stringify({ id: 999, name: 'stale' }), 1);

    // Cache hit should return the manually-set stale data
    const staleResult = await provider.get('overwrite-key');
    expect(staleResult).toEqual({ id: 999, name: 'stale' });

    // fetchFn should NOT have been called again (cache hit)
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
