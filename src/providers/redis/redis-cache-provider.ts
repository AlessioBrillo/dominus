import type { Redis } from 'ioredis';
import { getRedisClient, type RedisClient } from './redis-client.js';

interface MemCacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class RedisCacheProvider<T> {
  readonly #redisClient: RedisClient;
  readonly #namespace: string;
  readonly #defaultTtlMs: number;
  readonly #localCache: Map<string, MemCacheEntry<T>> | null;
  readonly #localCacheMax: number;

  constructor(options: {
    namespace: string;
    defaultTtlMs?: number;
    localCacheSize?: number;
    localCacheTtlMs?: number;
    redisClient?: RedisClient;
  }) {
    this.#namespace = options.namespace;
    this.#defaultTtlMs = options.defaultTtlMs ?? 300_000;
    this.#redisClient = options.redisClient ?? getRedisClient();
    this.#localCacheMax = options.localCacheSize ?? 0;
    this.#localCache = options.localCacheSize && options.localCacheSize > 0 ? new Map() : null;
  }

  clearCache(): void {
    this.#localCache?.clear();
  }

  async get(term: string): Promise<T | null> {
    const localKey = `${this.#namespace}:${term}`;

    if (this.#localCache) {
      const entry = this.#localCache.get(localKey);
      if (entry && Date.now() < entry.expiresAt) {
        this.#localCache.delete(localKey);
        this.#localCache.set(localKey, entry);
        return entry.value;
      }
      if (entry) this.#localCache.delete(localKey);
    }

    const redisKey = this.#redisClient.prefixed(`cache:${this.#namespace}:${term}`);

    return this.#redisClient.withRedis(
      async (redis: Redis) => {
        const raw = await redis.get(redisKey);
        if (raw === null) return null;
        try {
          const value = JSON.parse(raw) as T;
          this.#setLocal(localKey, value);
          return value;
        } catch {
          await redis.del(redisKey);
          return null;
        }
      },
      async () => null,
    );
  }

  async set(term: string, value: T, ttlMs?: number): Promise<void> {
    const localKey = `${this.#namespace}:${term}`;
    this.#setLocal(localKey, value, ttlMs);

    const redisKey = this.#redisClient.prefixed(`cache:${this.#namespace}:${term}`);
    const serialized = JSON.stringify(value);
    const ttl = ttlMs ?? this.#defaultTtlMs;

    await this.#redisClient.withRedis(
      async (redis: Redis) => {
        await redis.setex(redisKey, Math.ceil(ttl / 1000), serialized);
      },
      async () => {},
    );
  }

  async delete(term: string): Promise<void> {
    this.#localCache?.delete(`${this.#namespace}:${term}`);

    const redisKey = this.#redisClient.prefixed(`cache:${this.#namespace}:${term}`);
    await this.#redisClient.withRedis(
      async (redis: Redis) => {
        await redis.del(redisKey);
      },
      async () => {},
    );
  }

  #setLocal(key: string, value: T, ttlMs?: number): void {
    if (!this.#localCache) return;
    if (this.#localCache.size >= this.#localCacheMax) {
      const oldest = this.#localCache.keys().next();
      if (!oldest.done && oldest.value) {
        this.#localCache.delete(oldest.value);
      }
    }
    this.#localCache.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.#defaultTtlMs),
    });
  }
}
