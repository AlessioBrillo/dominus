import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { ProviderCacheRepository } from '../../db/repositories/provider-cache-repository.js';
import { CachedTrademarkProvider } from '../cached-trademark-provider.js';
import type { TrademarkProvider } from '../../providers/trademark/trademark-provider.js';
import { ProviderError } from '../../types/errors.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

function makeDelegate(
  matches: { markName: string; owner: string; status: string; source: string }[],
): TrademarkProvider & { search: ReturnType<typeof vi.fn> } {
  return { search: vi.fn().mockResolvedValue(matches) };
}

function makeErrorDelegate(): TrademarkProvider & { search: ReturnType<typeof vi.fn> } {
  return {
    search: vi.fn().mockRejectedValue(new ProviderError('unavailable', 'test')),
  };
}

describe('CachedTrademarkProvider', () => {
  let provider: SqliteProvider;
  let cacheRepo: ProviderCacheRepository;

  beforeEach(() => {
    provider = openTestDb();
    cacheRepo = new ProviderCacheRepository(provider);
  });

  it('calls the delegate on cache miss and returns its results', async () => {
    const matches = [{ markName: 'NIKE', owner: 'Nike', status: '6-REGISTERED', source: 'USPTO' }];
    const delegate = makeDelegate(matches);
    const provider = new CachedTrademarkProvider(delegate, cacheRepo, 'USPTO', 7);

    const results = await provider.search('nike');

    expect(results).toEqual(matches);
    expect(delegate.search).toHaveBeenCalledOnce();
    expect(delegate.search).toHaveBeenCalledWith('nike');
  });

  it('writes results to the cache after a delegate call', async () => {
    const matches = [{ markName: 'NIKE', owner: 'Nike', status: '6-REGISTERED', source: 'USPTO' }];
    const delegate = makeDelegate(matches);
    const provider = new CachedTrademarkProvider(delegate, cacheRepo, 'USPTO', 7);

    await provider.search('nike');

    const cached = await cacheRepo.get('nike', 'trademark:USPTO');
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached!);
    expect(parsed).toEqual(matches);
  });

  it('returns cached result and does NOT call the delegate on a cache hit', async () => {
    const matches = [{ markName: 'NIKE', owner: 'Nike', status: '6-REGISTERED', source: 'USPTO' }];
    const delegate = makeDelegate(matches);
    const provider = new CachedTrademarkProvider(delegate, cacheRepo, 'USPTO', 7);

    // First call: cache miss → delegate called
    await provider.search('nike');
    expect(delegate.search).toHaveBeenCalledOnce();

    // Second call: cache hit → delegate NOT called again
    const results = await provider.search('nike');
    expect(delegate.search).toHaveBeenCalledOnce(); // still 1
    expect(results).toEqual(matches);
  });

  it('caches an empty match array as a negative result', async () => {
    const delegate = makeDelegate([]);
    const provider = new CachedTrademarkProvider(delegate, cacheRepo, 'USPTO', 7);

    await provider.search('brandablexy');
    await provider.search('brandablexy');

    // Delegate only called once; second call from cache
    expect(delegate.search).toHaveBeenCalledOnce();
    const cached = await cacheRepo.get('brandablexy', 'trademark:USPTO');
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached!)).toEqual([]);
  });

  it('propagates delegate errors (so the gate counts the source as down)', async () => {
    const delegate = makeErrorDelegate();
    const provider = new CachedTrademarkProvider(delegate, cacheRepo, 'USPTO', 7);

    await expect(provider.search('test')).rejects.toBeInstanceOf(ProviderError);
  });

  it('does NOT write to cache when the delegate errors', async () => {
    const delegate = makeErrorDelegate();
    const provider = new CachedTrademarkProvider(delegate, cacheRepo, 'USPTO', 7);

    await provider.search('test').catch(() => undefined);

    const cached = await cacheRepo.get('test', 'trademark:USPTO');
    expect(cached).toBeNull();
  });

  it('cache is source-scoped: USPTO and EUIPO entries do not collide', async () => {
    const delegate = makeDelegate([]);
    const provider = new CachedTrademarkProvider(delegate, cacheRepo, 'USPTO', 7);

    await provider.search('brandablexy');
    await provider.search('brandablexy');

    // Delegate only called once; second call from cache
    expect(delegate.search).toHaveBeenCalledOnce();
    const cached = await cacheRepo.get('brandablexy', 'trademark:USPTO');
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached!)).toEqual([]);
  });

  it('propagates delegate errors (so the gate counts the source as down)', async () => {
    const delegate = makeErrorDelegate();
    const provider = new CachedTrademarkProvider(delegate, cacheRepo, 'USPTO', 7);

    await expect(provider.search('test')).rejects.toBeInstanceOf(ProviderError);
  });

  it('does NOT write to cache when the delegate errors', async () => {
    const delegate = makeErrorDelegate();
    const provider = new CachedTrademarkProvider(delegate, cacheRepo, 'USPTO', 7);

    await provider.search('test').catch(() => undefined);

    const cached = await cacheRepo.get('test', 'trademark:USPTO');
    expect(cached).toBeNull();
  });

  it('cache is source-scoped: USPTO and EUIPO entries do not collide', async () => {
    const usptoMatches = [
      { markName: 'USPTO-MARK', owner: 'A', status: 'active', source: 'USPTO' },
    ];
    const euipoMatches = [
      { markName: 'EUIPO-MARK', owner: 'B', status: 'Registered', source: 'EUIPO' },
    ];

    const usptoDelegate = makeDelegate(usptoMatches);
    const euipoDelegate = makeDelegate(euipoMatches);

    const usptoProvider = new CachedTrademarkProvider(usptoDelegate, cacheRepo, 'USPTO', 7);
    const euipoProvider = new CachedTrademarkProvider(euipoDelegate, cacheRepo, 'EUIPO', 7);

    await usptoProvider.search('testbrand');
    await euipoProvider.search('testbrand');

    // Read from separate providers — each should get its own cached source
    const usptoResult = await usptoProvider.search('testbrand');
    const euipoResult = await euipoProvider.search('testbrand');

    expect(usptoResult).toEqual(usptoMatches);
    expect(euipoResult).toEqual(euipoMatches);
    // Delegates each called exactly once (cache hit on third call)
    expect(usptoDelegate.search).toHaveBeenCalledOnce();
    expect(euipoDelegate.search).toHaveBeenCalledOnce();
  });
});
