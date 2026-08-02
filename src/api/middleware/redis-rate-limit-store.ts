// SPDX-License-Identifier: AGPL-3.0-only
import { MemoryStore, type ClientRateLimitInfo, type Store } from 'express-rate-limit';
import type { Redis } from 'ioredis';
import type { RedisClient } from '../../providers/redis/redis-client.js';

/**
 * express-rate-limit Store backed by Redis (fixed-window counters).
 *
 * In a multi-instance deployment the default MemoryStore would give every
 * replica its own counter — the effective limit scales with the number of
 * containers. This store shares one counter per client key across all
 * replicas through Redis. When Redis is unavailable, every operation falls
 * back to an in-memory MemoryStore so rate limiting is still enforced
 * per-instance (degraded, never disabled).
 */
export class RedisRateLimitStore implements Store {
  readonly #client: RedisClient;
  readonly #fallback: MemoryStore;
  readonly #windowMs: number;

  constructor(client: RedisClient, windowMs: number) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(`RedisRateLimitStore requires a positive windowMs, got ${windowMs}`);
    }
    this.#client = client;
    this.#windowMs = windowMs;
    this.#fallback = new MemoryStore();
    // MemoryStore only learns its window through init(); without it the
    // resetTime of every client stays invalid and counters never recycle.
    this.#fallback.init({ windowMs } as Parameters<MemoryStore['init']>[0]);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const redisKey = this.#client.prefixed(`rl:${key}`);
    return this.#client.withRedis(
      async (redis: Redis) => {
        const pipeline = redis.pipeline();
        pipeline.incr(redisKey);
        pipeline.pttl(redisKey);
        const results = await pipeline.exec();
        const totalHits = results?.[0]?.[1];
        if (typeof totalHits !== 'number') {
          throw new Error('Redis INCR did not return a numeric hit count');
        }
        const ttlRaw = results?.[1]?.[1];
        let ttl: number;
        if (typeof ttlRaw !== 'number' || ttlRaw === -1) {
          // First hit of the window (or key with no expiry): set it.
          await redis.pexpire(redisKey, this.#windowMs);
          ttl = this.#windowMs;
        } else {
          ttl = ttlRaw;
        }
        return {
          totalHits,
          resetTime: ttl > 0 ? new Date(Date.now() + ttl) : undefined,
        };
      },
      async () => this.#fallback.increment(key),
    );
  }

  async decrement(key: string): Promise<void> {
    const redisKey = this.#client.prefixed(`rl:${key}`);
    return this.#client.withRedis(
      async (redis: Redis) => {
        const raw = await redis.get(redisKey);
        if (raw === null) return;
        const next = Number(raw) - 1;
        if (next <= 0) {
          await redis.del(redisKey);
        } else {
          await redis.set(redisKey, String(next), 'KEEPTTL');
        }
      },
      async () => this.#fallback.decrement(key),
    );
  }

  async resetKey(key: string): Promise<void> {
    const redisKey = this.#client.prefixed(`rl:${key}`);
    return this.#client.withRedis(
      async (redis: Redis) => {
        await redis.del(redisKey);
      },
      async () => this.#fallback.resetKey(key),
    );
  }
}
