// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisRateLimiter } from '../redis-rate-limiter.js';
import type { RedisClient } from '../redis-client.js';
import { runWithTenant } from '../../../utils/tenant-context.js';

function makeRedis(cards: number[]): Redis {
  const pipeline = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    exec: vi.fn(() => {
      const card = cards.length > 0 ? cards.shift() : cards.at(-1);
      return Promise.resolve([
        [null, 0],
        [null, card],
      ]);
    }),
  };
  return {
    pipeline: vi.fn(() => pipeline),
    zadd: vi.fn(),
    pexpire: vi.fn(),
  } as unknown as Redis;
}

function makeRedisClient(redis: Redis): RedisClient {
  return {
    client: redis,
    isConnected: true,
    keyPrefix: 'dominus:',
    prefixed: (key: string) => `dominus:${key}`,
    withRedis: vi.fn(
      async <T>(fn: (r: Redis) => Promise<T>, fallback: () => Promise<T>): Promise<T> => {
        try {
          return await fn(redis);
        } catch {
          return fallback();
        }
      },
    ),
    ping: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as RedisClient;
}

describe('RedisRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('acquires immediately when a token is available', async () => {
    const redis = makeRedis([3]);
    const limiter = new RedisRateLimiter({ tokens: 5, intervalMs: 1000 }, makeRedisClient(redis));

    await expect(limiter.acquire()).resolves.toBeUndefined();
    expect(redis.zadd).toHaveBeenCalledTimes(1);
    expect(redis.pexpire).toHaveBeenCalledTimes(1);
  });

  it('polls until a token frees up, then acquires', async () => {
    const redis = makeRedis([5, 5, 2]);
    const limiter = new RedisRateLimiter({ tokens: 5, intervalMs: 1000 }, makeRedisClient(redis));

    const pending = limiter.acquire();
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBeUndefined();
    expect(redis.zadd).toHaveBeenCalledTimes(1);
  });

  it('rejects when the bucket stays full beyond the wait budget', async () => {
    // Regression: the previous implementation retried via unbounded
    // recursion — a perpetually saturated bucket made acquire() never
    // settle. The wait must be capped and fail fast.
    const redis = makeRedis([5]);
    const limiter = new RedisRateLimiter(
      { tokens: 1, intervalMs: 1000, maxWaitMs: 5000 },
      makeRedisClient(redis),
    );

    const pending = limiter.acquire();
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'RateLimiterWaitTimeoutError',
      waitBudgetMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(6000);
    await rejection;
  });

  it('honors a custom maxWaitMs', async () => {
    const redis = makeRedis([5]);
    const limiter = new RedisRateLimiter(
      { tokens: 1, intervalMs: 1000, maxWaitMs: 100 },
      makeRedisClient(redis),
    );

    const pending = limiter.acquire();
    const rejection = expect(pending).rejects.toMatchObject({ waitBudgetMs: 100 });
    await vi.advanceTimersByTimeAsync(150);
    await rejection;
  });
});

// --- Distributed per-tenant fair share (ADR-0041) ---
//
// On a shared Redis budget, a single heavy tenant must not starve the rest
// of the platform. When fairShare is enabled, acquire() reserves an
// independent sliding window of `perTenantTokens` keyed by the tenant
// resolved from AsyncLocalStorage, on top of the global window.

/** Stateful fake: each window is a counter; every zadd grows its count and
 *  every exec reports the count for the keys queried in the pipeline. */
function makeFairRedis(): { redis: Redis; windows: Map<string, number> } {
  const windows = new Map<string, number>();
  const redis = {
    pipeline: vi.fn(() => {
      const queried: string[] = [];
      const pipeline = {
        zremrangebyscore: vi.fn((key: string) => {
          queried.push(key);
          return pipeline;
        }),
        zcard: vi.fn((key: string) => {
          queried.push(key);
          return pipeline;
        }),
        exec: vi.fn(async () => {
          const results: Array<[null, number]> = queried.map((key) => [
            null,
            windows.get(key) ?? 0,
          ]);
          queried.length = 0;
          return Promise.resolve(results);
        }),
      };
      return pipeline;
    }),
    zadd: vi.fn(async (key: string) => {
      windows.set(key, (windows.get(key) ?? 0) + 1);
    }),
    pexpire: vi.fn(async () => Promise.resolve(1)),
  } as unknown as Redis;
  return { redis, windows };
}

function makeFairRedisClient(redis: Redis): RedisClient {
  return {
    client: redis,
    isConnected: true,
    keyPrefix: 'dominus:',
    prefixed: (key: string) => `dominus:${key}`,
    withRedis: vi.fn(
      async <T>(fn: (r: Redis) => Promise<T>, fallback: () => Promise<T>): Promise<T> => {
        try {
          return await fn(redis);
        } catch {
          return fallback();
        }
      },
    ),
    ping: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as RedisClient;
}

describe('RedisRateLimiter fair share (ADR-0041)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reserves an independent per-tenant window on top of the global cap', async () => {
    const { redis, windows } = makeFairRedis();
    const limiter = new RedisRateLimiter(
      {
        tokens: 20,
        intervalMs: 1000,
        namespace: 'dns',
        maxWaitMs: 5000,
        fairShare: true,
        perTenantTokens: 1,
      },
      makeFairRedisClient(redis),
    );

    await runWithTenant('tenant-a', () => limiter.acquire());
    // First acquire passes — the tenant window is still empty.
    expect(windows.get('dominus:ratelimit:dns')).toBe(1);
    expect(windows.get('dominus:ratelimit:dns:tenant:tenant-a')).toBe(1);

    // Second acquire from the same tenant saturates its independent window
    // (1/1) and must fail fast rather than consuming the shared platform
    // budget the way a single global bucket would.
    const pending = runWithTenant('tenant-a', () => limiter.acquire());
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'RateLimiterWaitTimeoutError',
    });
    await vi.advanceTimersByTimeAsync(6000);
    await rejection;
  });

  it('lets a second tenant acquire while the first tenant is saturated', async () => {
    const { redis, windows } = makeFairRedis();
    const limiter = new RedisRateLimiter(
      {
        tokens: 20,
        intervalMs: 1000,
        namespace: 'dns',
        maxWaitMs: 100,
        fairShare: true,
        perTenantTokens: 1,
      },
      makeFairRedisClient(redis),
    );

    await runWithTenant('tenant-a', () => limiter.acquire());
    const blocked = runWithTenant('tenant-a', () => limiter.acquire());
    await vi.advanceTimersByTimeAsync(200);
    await expect(blocked).rejects.toMatchObject({ name: 'RateLimiterWaitTimeoutError' });

    // tenant-b still gets its own slice despite A saturating its window.
    await expect(runWithTenant('tenant-b', () => limiter.acquire())).resolves.toBeUndefined();
    expect(windows.get('dominus:ratelimit:dns:tenant:tenant-b')).toBe(1);
    // A consumed exactly one token on both the global and its tenant window.
    expect(windows.get('dominus:ratelimit:dns:tenant:tenant-a')).toBe(1);
    expect(windows.get('dominus:ratelimit:dns')).toBe(2);
  });

  it('does not enforce fair share when disabled', async () => {
    const { redis, windows } = makeFairRedis();
    const limiter = new RedisRateLimiter(
      {
        tokens: 20,
        intervalMs: 1000,
        namespace: 'dns',
        fairShare: false,
      },
      makeFairRedisClient(redis),
    );

    await runWithTenant('tenant-a', () => limiter.acquire());
    expect(windows.get('dominus:ratelimit:dns:tenant:tenant-a')).toBeUndefined();
    expect(windows.get('dominus:ratelimit:dns')).toBe(1);
  });
});
