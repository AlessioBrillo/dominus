// SPDX-License-Identifier: AGPL-3.0-only
import type { Redis } from 'ioredis';
import { getLogger } from '../../logger.js';
import { getRedisClient, type RedisClient } from './redis-client.js';
import { RateLimiterQueueFullError, type DnsPriority } from '../rate-limiter.js';
import { getTenantId } from '../../utils/tenant-context.js';

const logger = getLogger();

export interface RedisRateLimiterConfig {
  tokens: number;
  intervalMs: number;
  maxQueueSize?: number;
  namespace?: string;
  /** Hard cap on how long acquire() polls a saturated bucket before
   *  failing fast (default: max(2 × intervalMs, 5s)). Prevents callers
   *  from waiting indefinitely on a perpetually full bucket. */
  maxWaitMs?: number;
  /** Distributed per-tenant fair share (ADR-0041). When enabled, acquire()
   *  also enforces an independent sliding window of `perTenantTokens` keyed
   *  by the tenant resolved from AsyncLocalStorage, so one tenant can never
   *  monopolise the shared platform bucket. Enforcement is skipped for the
   *  community `'default'` tenant and when no tenant context is present. */
  fairShare?: boolean;
  /** Capacity of the per-tenant window used when `fairShare` is enabled.
   *  Must be lower than or equal to `tokens` to provide actual isolation. */
  perTenantTokens?: number;
  /** Refill window for the per-tenant bucket (default: `intervalMs`). Allows
   *  a faster-draining tenant window than the shared platform bucket. */
  perTenantIntervalMs?: number;
}

/** Raised when acquire() polls a saturated bucket for maxWaitMs without
 *  ever being granted a token. Callers should back off and retry later —
 *  a bounded failure beats an unbounded hang. */
export class RateLimiterWaitTimeoutError extends Error {
  readonly waitBudgetMs: number;
  readonly retryDelayMs: number;

  constructor(waitBudgetMs: number, retryDelayMs: number) {
    super(
      `Redis rate limiter still saturated after ${waitBudgetMs}ms ` +
        `(polling every ${retryDelayMs}ms)`,
    );
    this.name = 'RateLimiterWaitTimeoutError';
    this.waitBudgetMs = waitBudgetMs;
    this.retryDelayMs = retryDelayMs;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
  readonly #maxWaitMs: number;
  readonly #fairShare: boolean;
  readonly #perTenantTokens: number;
  readonly #perTenantIntervalMs: number;
  readonly #redisClient: RedisClient;
  #queue: QueuedAcquire[] = [];
  #processing = false;

  get maxTokens(): number {
    return this.#tokens;
  }

  constructor(config: RedisRateLimiterConfig, redisClient?: RedisClient) {
    this.#tokens = config.tokens;
    this.#intervalMs = config.intervalMs;
    this.#maxQueueSize = config.maxQueueSize ?? 1000;
    this.#namespace = config.namespace ?? 'default';
    this.#maxWaitMs = config.maxWaitMs ?? Math.max(config.intervalMs * 2, 5_000);
    this.#fairShare = config.fairShare ?? false;
    this.#perTenantTokens = config.perTenantTokens ?? config.tokens;
    this.#perTenantIntervalMs = config.perTenantIntervalMs ?? config.intervalMs;
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

  async acquire(priority?: DnsPriority): Promise<void> {
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

    // Priority is accepted for interface compatibility. In Redis-backed
    // distributed mode, the shared bucket enforces global fairness;
    // priority reservation is handled at the application layer by
    // configuring separate namespaces (dns vs dns-consensus).
    void priority;

    // Poll the bucket until a token frees up, but never longer than
    // maxWaitMs: the bucket can stay saturated indefinitely (sustained
    // load), and an unbounded retry loop would stack one async frame per
    // poll per caller. A bounded wait with fail-fast keeps the pipeline
    // responsive and the heap flat.
    const retryDelayMs = Math.ceil(this.#intervalMs / Math.max(this.#tokens, 1));
    const deadline = Date.now() + this.#maxWaitMs;

    for (;;) {
      if (await this.#tryConsumeToken()) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new RateLimiterWaitTimeoutError(this.#maxWaitMs, retryDelayMs);
      }
      await sleep(Math.min(retryDelayMs, remaining));
    }
  }

  async #tryConsumeToken(): Promise<boolean> {
    const now = Date.now();
    const key = this.#redisClient.prefixed(`ratelimit:${this.#namespace}`);
    const tenantKey = this.#tenantKey();

    return this.#redisClient.withRedis(
      async (redis: Redis) => {
        const pipeline = redis.pipeline();
        pipeline.zremrangebyscore(key, '-inf', now - this.#intervalMs);
        pipeline.zcard(key);
        if (tenantKey) {
          pipeline.zremrangebyscore(tenantKey, '-inf', now - this.#perTenantIntervalMs);
          pipeline.zcard(tenantKey);
        }
        const results = await pipeline.exec();
        if (!results) return false;
        const card = results[1]?.[1] as number | undefined;
        if (card === undefined) return false;
        if (card >= this.#tokens) return false;
        if (tenantKey) {
          const tenantCard = results[3]?.[1] as number | undefined;
          if (tenantCard === undefined) return false;
          if (tenantCard >= this.#perTenantTokens) return false;
        }
        await redis.zadd(key, now, `${now}:${Math.random()}`);
        if (tenantKey) {
          await redis.zadd(tenantKey, now, `${now}:${Math.random()}`);
        }
        await redis.pexpire(key, this.#intervalMs);
        if (tenantKey) {
          await redis.pexpire(tenantKey, this.#perTenantIntervalMs);
        }
        return true;
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

  async throttle<T>(fn: () => Promise<T>, priority?: DnsPriority): Promise<T> {
    await this.acquire(priority);
    return fn();
  }

  /** Key for the per-tenant fair-share window. Returns undefined when fair
   *  share is disabled, when no tenant context is present, or for the
   *  community `'default'` tenant — those callers just share the global
   *  platform bucket. */
  #tenantKey(): string | undefined {
    if (!this.#fairShare) return undefined;
    const tenant = getTenantId();
    if (!tenant || tenant === 'default') return undefined;
    return this.#redisClient.prefixed(`ratelimit:${this.#namespace}:tenant:${tenant}`);
  }
}
