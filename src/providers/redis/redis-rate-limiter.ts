import type { Redis } from 'ioredis';
import { getLogger } from '../../logger.js';
import { getRedisClient, type RedisClient } from './redis-client.js';
import { RateLimiterQueueFullError } from '../rate-limiter.js';

const logger = getLogger();

export interface RedisRateLimiterConfig {
  tokens: number;
  intervalMs: number;
  maxQueueSize?: number;
  namespace?: string;
}

export interface RedisRateLimiterMetrics {
  maxTokens: number;
  currentTokens: number;
  queueLength: number;
  maxQueueSize: number;
  tokensPerInterval: number;
  intervalMs: number;
  namespace: string;
}

interface QueuedAcquire {
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class RedisRateLimiter {
  readonly #tokens: number;
  readonly #intervalMs: number;
  readonly #maxQueueSize: number;
  readonly #namespace: string;
  readonly #redisClient: RedisClient;
  #queue: QueuedAcquire[] = [];
  #processing = false;

  constructor(config: RedisRateLimiterConfig, redisClient?: RedisClient) {
    this.#tokens = config.tokens;
    this.#intervalMs = config.intervalMs;
    this.#maxQueueSize = config.maxQueueSize ?? 1000;
    this.#namespace = config.namespace ?? 'default';
    this.#redisClient = redisClient ?? getRedisClient();
  }

  metrics(): RedisRateLimiterMetrics {
    return {
      maxTokens: this.#tokens,
      currentTokens: this.#tokens,
      queueLength: this.#queue.length,
      maxQueueSize: this.#maxQueueSize,
      tokensPerInterval: this.#tokens,
      intervalMs: this.#intervalMs,
      namespace: this.#namespace,
    };
  }

  async acquire(): Promise<void> {
    if (this.#maxQueueSize > 0 && this.#queue.length >= this.#maxQueueSize) {
      throw new RateLimiterQueueFullError(this.#queue.length, this.#maxQueueSize);
    }

    if (this.#maxQueueSize > 0 && this.#queue.length >= this.#maxQueueSize * 0.8) {
      logger.warn(
        {
          queueLength: this.#queue.length,
          maxQueueSize: this.#maxQueueSize,
          namespace: this.#namespace,
        },
        'RedisRateLimiter queue above 80% capacity',
      );
    }

    const now = Date.now();
    const key = this.#redisClient.prefixed(`ratelimit:${this.#namespace}`);

    const allowed = await this.#redisClient.withRedis(
      async (redis: Redis) => {
        const pipeline = redis.pipeline();
        pipeline.zremrangebyscore(key, '-inf', now - this.#intervalMs);
        pipeline.zcard(key);
        const results = await pipeline.exec();
        if (!results) return false;
        const card = results[1]?.[1] as number | undefined;
        if (card === undefined) return false;
        if (card < this.#tokens) {
          await redis.zadd(key, now, `${now}:${Math.random()}`);
          await redis.pexpire(key, this.#intervalMs);
          return true;
        }
        return false;
      },
      async () => {
        // Fallback: in-memory queue-based rate limiting
        return new Promise<boolean>((resolve, reject) => {
          this.#queue.push({
            resolve: () => resolve(true),
            reject,
          });
          if (!this.#processing) {
            void this.#processQueue();
          }
        });
      },
    );

    if (!allowed) {
      const waitMs = Math.ceil(this.#intervalMs / this.#tokens);
      await new Promise((r) => setTimeout(r, Math.min(waitMs, this.#intervalMs)));
      return this.acquire();
    }
  }

  async #processQueue(): Promise<void> {
    this.#processing = true;
    const msPerToken = this.#intervalMs / this.#tokens;
    try {
      while (this.#queue.length > 0) {
        const entry = this.#queue.shift()!;
        entry.resolve();
        if (this.#queue.length > 0) {
          await new Promise((r) => setTimeout(r, Math.max(msPerToken, 1)));
        }
      }
    } finally {
      this.#processing = false;
    }
  }

  async throttle<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    return fn();
  }
}
