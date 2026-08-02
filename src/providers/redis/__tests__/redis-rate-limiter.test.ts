// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisRateLimiter } from '../redis-rate-limiter.js';
import type { RedisClient } from '../redis-client.js';

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
