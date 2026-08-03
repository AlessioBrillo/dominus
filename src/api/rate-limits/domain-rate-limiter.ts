// SPDX-License-Identifier: AGPL-3.0-only
import type { Redis } from 'ioredis';
import type { RedisClient } from '../../providers/redis/redis-client.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface DomainRateLimiter {
  /** Returns true when the request is within the limit for ip+domain. */
  check(ip: string, domain: string): Promise<boolean>;
}

export interface DomainRateLimiterConfig {
  /** Fixed-window length in milliseconds. */
  windowMs: number;
  /** Maximum requests per ip+domain per window. */
  max: number;
  /** Maximum tracked keys in the in-memory fallback (default: 10000). */
  maxWindows?: number;
}

/**
 * Per-domain rate limiter with an in-memory fixed-window counter.
 * Used standalone (community edition, single instance) and as the
 * fallback for the Redis-backed limiter when Redis is unavailable.
 */
export class MemoryDomainRateLimiter implements DomainRateLimiter {
  readonly #windowMs: number;
  readonly #max: number;
  readonly #maxWindows: number;
  readonly #windows = new Map<string, { count: number; resetAt: number }>();

  constructor(config: DomainRateLimiterConfig) {
    this.#windowMs = config.windowMs;
    this.#max = config.max;
    this.#maxWindows = config.maxWindows ?? 10_000;
  }

  check(ip: string, domain: string): Promise<boolean> {
    return Promise.resolve(this.#checkSync(ip, domain));
  }

  #checkSync(ip: string, domain: string): boolean {
    const key = this.#key(ip, domain);
    const now = Date.now();

    this.#prune(now);

    const entry = this.#windows.get(key);
    if (!entry || now > entry.resetAt) {
      if (this.#windows.size >= this.#maxWindows) {
        logger.warn(
          { maxWindows: this.#maxWindows, currentSize: this.#windows.size },
          'Per-domain rate limiter at capacity — evicting oldest entry',
        );
        const oldest = this.#windows.keys().next();
        if (!oldest.done && oldest.value !== undefined) {
          this.#windows.delete(oldest.value);
        }
      }
      this.#windows.set(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }

    entry.count++;
    return entry.count <= this.#max;
  }

  #key(ip: string, domain: string): string {
    return `${ip}:${domain.toLowerCase()}`;
  }

  #prune(now: number): void {
    for (const [k, v] of this.#windows) {
      if (now > v.resetAt) this.#windows.delete(k);
    }
  }
}

/**
 * Per-domain rate limiter backed by a Redis fixed-window counter, shared
 * across all instances in a multi-replica deployment. Falls back to the
 * in-memory limiter on any Redis failure or disconnection.
 */
export class RedisDomainRateLimiter implements DomainRateLimiter {
  readonly #client: RedisClient;
  readonly #config: DomainRateLimiterConfig;
  readonly #fallback: MemoryDomainRateLimiter;

  constructor(
    client: RedisClient,
    config: DomainRateLimiterConfig,
    fallback: MemoryDomainRateLimiter = new MemoryDomainRateLimiter(config),
  ) {
    this.#client = client;
    this.#config = config;
    this.#fallback = fallback;
  }

  check(ip: string, domain: string): Promise<boolean> {
    const redisKey = this.#client.prefixed(`pubrl:${domain.toLowerCase()}:${ip}`);
    return this.#client.withRedis(
      async (redis: Redis) => {
        const count = await redis.incr(redisKey);
        if (count === 1) {
          await redis.pexpire(redisKey, this.#config.windowMs);
        }
        return count <= this.#config.max;
      },
      async () => this.#fallback.check(ip, domain),
    );
  }
}

/**
 * Builds the per-domain limiter: Redis-backed when a connected Redis
 * client is available, in-memory otherwise.
 */
export function createDomainRateLimiter(
  config: DomainRateLimiterConfig,
  redisClient?: RedisClient,
): DomainRateLimiter {
  const memory = new MemoryDomainRateLimiter(config);
  if (redisClient?.isConnected) {
    return new RedisDomainRateLimiter(redisClient, config, memory);
  }
  return memory;
}
