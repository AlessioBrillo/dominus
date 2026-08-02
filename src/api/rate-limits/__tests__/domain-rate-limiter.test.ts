// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { RedisClient } from '../../../providers/redis/redis-client.js';
import {
  MemoryDomainRateLimiter,
  RedisDomainRateLimiter,
  createDomainRateLimiter,
  type DomainRateLimiterConfig,
} from '../domain-rate-limiter.js';

const CONFIG: DomainRateLimiterConfig = { windowMs: 60_000, max: 5 };

function makeConnectedRedisClient(): {
  client: RedisClient;
  redis: { incr: ReturnType<typeof vi.fn>; pexpire: ReturnType<typeof vi.fn> };
} {
  const redis = {
    incr: vi.fn(async () => 1),
    pexpire: vi.fn(async () => 1),
  };
  const client = {
    prefixed: (key: string) => `dominus:${key}`,
    isConnected: true,
    withRedis: vi.fn(
      async <T>(fn: (r: Redis) => Promise<T>, _fallback: () => Promise<T>): Promise<T> =>
        fn(redis as unknown as Redis),
    ),
  } as unknown as RedisClient;
  return { client, redis };
}

describe('MemoryDomainRateLimiter', () => {
  let limiter: MemoryDomainRateLimiter;

  beforeEach(() => {
    limiter = new MemoryDomainRateLimiter(CONFIG);
  });

  it('allows requests up to the max per window', async () => {
    for (let i = 0; i < 5; i++) {
      await expect(limiter.check('1.2.3.4', 'example.com')).resolves.toBe(true);
    }
  });

  it('blocks requests beyond the max per window', async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.check('1.2.3.4', 'example.com');
    }
    await expect(limiter.check('1.2.3.4', 'example.com')).resolves.toBe(false);
  });

  it('tracks ip and domain independently', async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.check('1.2.3.4', 'example.com');
    }
    await expect(limiter.check('1.2.3.4', 'example.com')).resolves.toBe(false);
    await expect(limiter.check('1.2.3.4', 'other.com')).resolves.toBe(true);
    await expect(limiter.check('9.9.9.9', 'example.com')).resolves.toBe(true);
  });

  it('normalizes domain casing in the key', async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.check('1.2.3.4', 'EXAMPLE.com');
    }
    await expect(limiter.check('1.2.3.4', 'example.com')).resolves.toBe(false);
  });

  it('resets counters after the window elapses', async () => {
    const limiter = new MemoryDomainRateLimiter({ windowMs: 5, max: 1 });
    await limiter.check('1.2.3.4', 'example.com');
    await expect(limiter.check('1.2.3.4', 'example.com')).resolves.toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    await expect(limiter.check('1.2.3.4', 'example.com')).resolves.toBe(true);
  });
});

describe('RedisDomainRateLimiter', () => {
  it('increments the Redis counter for the ip+domain key', async () => {
    const { client, redis } = makeConnectedRedisClient();
    redis.incr.mockResolvedValue(1);
    const limiter = new RedisDomainRateLimiter(client, CONFIG);

    await expect(limiter.check('1.2.3.4', 'example.com')).resolves.toBe(true);

    expect(redis.incr).toHaveBeenCalledWith('dominus:pubrl:example.com:1.2.3.4');
    expect(redis.pexpire).toHaveBeenCalledWith('dominus:pubrl:example.com:1.2.3.4', 60_000);
  });

  it('sets expiry only on the first hit of the window', async () => {
    const { client, redis } = makeConnectedRedisClient();
    redis.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    const limiter = new RedisDomainRateLimiter(client, CONFIG);

    await limiter.check('1.2.3.4', 'example.com');
    await limiter.check('1.2.3.4', 'example.com');

    expect(redis.pexpire).toHaveBeenCalledTimes(1);
  });

  it('blocks when the Redis counter exceeds the max', async () => {
    const { client, redis } = makeConnectedRedisClient();
    redis.incr.mockResolvedValue(6);
    const limiter = new RedisDomainRateLimiter(client, CONFIG);

    await expect(limiter.check('1.2.3.4', 'example.com')).resolves.toBe(false);
  });

  it('falls back to the memory limiter when Redis fails', async () => {
    const memory = new MemoryDomainRateLimiter(CONFIG);
    const client = {
      prefixed: (key: string) => `dominus:${key}`,
      isConnected: true,
      withRedis: vi.fn(
        async <T>(_fn: (r: Redis) => Promise<T>, fallback: () => Promise<T>): Promise<T> =>
          fallback(),
      ),
    } as unknown as RedisClient;
    const limiter = new RedisDomainRateLimiter(client, CONFIG, memory);

    await expect(limiter.check('1.2.3.4', 'example.com')).resolves.toBe(true);
  });
});

describe('createDomainRateLimiter', () => {
  it('returns a memory limiter without a Redis client', () => {
    const limiter = createDomainRateLimiter(CONFIG);
    expect(limiter).toBeInstanceOf(MemoryDomainRateLimiter);
  });

  it('returns a memory limiter when Redis is not connected', () => {
    const client = {
      prefixed: (key: string) => `dominus:${key}`,
      isConnected: false,
      withRedis: vi.fn(),
    } as unknown as RedisClient;
    const limiter = createDomainRateLimiter(CONFIG, client);
    expect(limiter).toBeInstanceOf(MemoryDomainRateLimiter);
  });

  it('returns a Redis limiter when Redis is connected', () => {
    const { client } = makeConnectedRedisClient();
    const limiter = createDomainRateLimiter(CONFIG, client);
    expect(limiter).toBeInstanceOf(RedisDomainRateLimiter);
  });
});
