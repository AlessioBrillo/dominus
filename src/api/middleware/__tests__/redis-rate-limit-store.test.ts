// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { RedisClient } from '../../../providers/redis/redis-client.js';
import { RedisRateLimitStore } from '../redis-rate-limit-store.js';

interface FakePipeline {
  incr(key: string): FakePipeline;
  pttl(key: string): FakePipeline;
  exec(): Promise<Array<[Error | null, unknown]>>;
}

interface FakeRedis {
  pipeline(): FakePipeline;
  pexpire(key: string, ms: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<string | null>;
  del(key: string): Promise<number>;
}

function makeFakeRedis(initial: Record<string, number> = {}): FakeRedis {
  const counts = new Map<string, number>(Object.entries(initial));
  return {
    pipeline(): FakePipeline {
      const incrKeys: string[] = [];
      const pttlKeys: string[] = [];
      const self: FakePipeline = {
        incr(key: string) {
          incrKeys.push(key);
          return self;
        },
        pttl(key: string) {
          pttlKeys.push(key);
          return self;
        },
        async exec() {
          const results: Array<[Error | null, unknown]> = [];
          for (const key of incrKeys) {
            const next = (counts.get(key) ?? 0) + 1;
            counts.set(key, next);
            results.push([null, next]);
          }
          for (const key of pttlKeys) {
            // -1 signals "no TTL yet" (first hit); any positive value
            // means an expiry is already set on the key.
            const ttl = counts.get(key) === 1 ? -1 : 42_000;
            results.push([null, ttl]);
          }
          return results;
        },
      };
      return self;
    },
    pexpire: vi.fn(async () => 1),
    get: vi.fn(async (key: string) => {
      const value = counts.get(key);
      return value === undefined ? null : String(value);
    }),
    set: vi.fn(async (key: string, value: string) => {
      counts.set(key, Number(value));
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const existed = counts.delete(key);
      return existed ? 1 : 0;
    }),
  };
}

function makeConnectedRedisClient(redis: FakeRedis): RedisClient {
  return {
    prefixed: (key: string) => `dominus:${key}`,
    isConnected: true,
    withRedis: vi.fn(async <T>(fn: (r: Redis) => Promise<T>): Promise<T> =>
      fn(redis as unknown as Redis),
    ),
  } as unknown as RedisClient;
}

function makeDisconnectedRedisClient(): RedisClient {
  return {
    prefixed: (key: string) => `dominus:${key}`,
    isConnected: false,
    withRedis: vi.fn(
      async <T>(_fn: (r: Redis) => Promise<T>, fallback: () => Promise<T>): Promise<T> =>
        fallback(),
    ),
  } as unknown as RedisClient;
}

describe('RedisRateLimitStore', () => {
  it('rejects a non-positive window', () => {
    expect(() => new RedisRateLimitStore(makeConnectedRedisClient(makeFakeRedis()), 0)).toThrow();
  });

  it('increments the Redis counter on each call', async () => {
    const redis = makeFakeRedis();
    const store = new RedisRateLimitStore(makeConnectedRedisClient(redis), 60_000);

    let info = await store.increment('ip-1');
    expect(info.totalHits).toBe(1);
    info = await store.increment('ip-1');
    expect(info.totalHits).toBe(2);
  });

  it('sets an expiry when the key has no TTL yet', async () => {
    const redis = makeFakeRedis();
    const store = new RedisRateLimitStore(makeConnectedRedisClient(redis), 60_000);

    await store.increment('ip-1');

    expect(redis.pexpire).toHaveBeenCalledWith('dominus:rl:ip-1', 60_000);
  });

  it('returns a resetTime when a TTL is present', async () => {
    const redis = makeFakeRedis({ 'dominus:rl:ip-1': 3 });
    const store = new RedisRateLimitStore(makeConnectedRedisClient(redis), 60_000);

    const info = await store.increment('ip-1');

    expect(info.totalHits).toBe(4);
    expect(info.resetTime).toBeInstanceOf(Date);
    expect(info.resetTime!.getTime()).toBeGreaterThan(Date.now());
  });

  it('decrements and deletes the key when the count reaches zero', async () => {
    const redis = makeFakeRedis({ 'dominus:rl:ip-1': 1 });
    const store = new RedisRateLimitStore(makeConnectedRedisClient(redis), 60_000);

    await store.decrement('ip-1');

    expect(redis.del).toHaveBeenCalledWith('dominus:rl:ip-1');
  });

  it('decrements and keeps the key when the count stays positive', async () => {
    const redis = makeFakeRedis({ 'dominus:rl:ip-1': 5 });
    const store = new RedisRateLimitStore(makeConnectedRedisClient(redis), 60_000);

    await store.decrement('ip-1');

    expect(redis.set).toHaveBeenCalledWith('dominus:rl:ip-1', '4', 'KEEPTTL');
  });

  it('resets the key', async () => {
    const redis = makeFakeRedis({ 'dominus:rl:ip-1': 5 });
    const store = new RedisRateLimitStore(makeConnectedRedisClient(redis), 60_000);

    await store.resetKey('ip-1');

    expect(redis.del).toHaveBeenCalledWith('dominus:rl:ip-1');
  });

  it('falls back to the in-memory store when Redis is not connected', async () => {
    const client = makeDisconnectedRedisClient();
    const store = new RedisRateLimitStore(client, 60_000);

    // MemoryStore returns the same mutable client object on every
    // increment, so snapshot the hit count before the next call.
    const first = await store.increment('ip-1');
    const firstHits = first.totalHits;
    const second = await store.increment('ip-1');

    expect(firstHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(second.resetTime).toBeInstanceOf(Date);
  });

  it('falls back to the in-memory store when Redis errors', async () => {
    const redis = makeFakeRedis();
    const client = makeConnectedRedisClient(redis);
    vi.mocked(client.withRedis).mockImplementation(
      async <T>(_fn: (r: Redis) => Promise<T>, fallback: () => Promise<T>): Promise<T> =>
        fallback(),
    );
    const store = new RedisRateLimitStore(client, 60_000);

    const info = await store.increment('ip-1');

    expect(info.totalHits).toBe(1);
  });
});
