// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Minimal interface that both in-memory RateLimiter and RedisRateLimiter
 * implement. Used where the rate limiter implementation is injected but
 * only acquire() and throttle() are consumed.
 */
export type DnsPriority = 'primary' | 'consensus' | 'tertiary';

export interface RateLimiterLike {
  acquire(priority?: DnsPriority): Promise<void>;
  throttle<T>(fn: () => Promise<T>, priority?: DnsPriority): Promise<T>;
  /** Maximum burst capacity (maxTokens). Used by bulk operations to cap
   *  concurrent workers to the rate limiter's allowance, preventing
   *  over-spawning workers that immediately queue on the rate limiter. */
  readonly maxTokens: number;
}

export interface RateLimiterConfig {
  maxTokens: number;
  tokensPerInterval: number;
  intervalMs: number;
  /** Maximum number of pending acquire requests. 0 = unlimited. When exceeded, acquire() rejects. */
  maxQueueSize?: number;
}

export interface RateLimiterMetrics {
  /** Maximum burst capacity. */
  maxTokens: number;
  /** Current available tokens. */
  currentTokens: number;
  /** Number of requests waiting in the queue. */
  queueLength: number;
  /** Maximum queue size before rejection (0 = unlimited). */
  maxQueueSize: number;
  /** Tokens added per interval. */
  tokensPerInterval: number;
  /** Refill interval in milliseconds. */
  intervalMs: number;
}

export class RateLimiterQueueFullError extends Error {
  readonly queueSize: number;
  readonly maxQueueSize: number;

  constructor(queueSize: number, maxQueueSize: number) {
    super(`Rate limiter queue full: ${queueSize} queued, max ${maxQueueSize}`);
    this.name = 'RateLimiterQueueFullError';
    this.queueSize = queueSize;
    this.maxQueueSize = maxQueueSize;
  }
}

import { getLogger } from '../logger.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const UNLIMITED_CONFIG: RateLimiterConfig = {
  maxTokens: Number.POSITIVE_INFINITY,
  tokensPerInterval: Number.POSITIVE_INFINITY,
  intervalMs: 1,
};

interface QueuedAcquire {
  resolve: () => void;
  reject: (err: unknown) => void;
  priority: DnsPriority | undefined;
}

export class RateLimiter {
  readonly #maxTokens: number;
  readonly #tokensPerInterval: number;
  readonly #intervalMs: number;
  readonly #maxQueueSize: number;
  #tokens: number;
  #lastRefill: number;
  #queue: QueuedAcquire[] = [];
  #processing = false;

  constructor(config: RateLimiterConfig) {
    this.#maxTokens = config.maxTokens;
    this.#tokensPerInterval = config.tokensPerInterval;
    this.#intervalMs = config.intervalMs;
    this.#maxQueueSize = config.maxQueueSize ?? 1000;
    this.#tokens = config.maxTokens;
    this.#lastRefill = Date.now();
  }

  /** Returns the maximum burst capacity (for subclasses). */
  protected getMaxTokens(): number {
    return this.#maxTokens;
  }

  /** Returns the number of tokens reserved for priority (consensus/tertiary) legs.
   *  By default, no reservation (0) — priority logic is opt-in via
   *  DNS_CONSENSUS_PRIORITY_RESERVED_RATIO config. */
  protected getReservedTokens(): number {
    return 0;
  }

  /** Tokens available for 'primary' priority acquisitions. */
  protected getPrimaryAvailableTokens(): number {
    return this.#tokens - this.getReservedTokens();
  }

  /** Tokens available for 'consensus'/'tertiary' priority acquisitions. */
  protected getPriorityAvailableTokens(): number {
    return this.#tokens;
  }

  get maxTokens(): number {
    return this.#maxTokens;
  }

  static unlimited(): RateLimiter {
    return new RateLimiter(UNLIMITED_CONFIG);
  }

  /**
   * Return current operational metrics for monitoring and health-check.
   * Exposes queue depth and token state so operators can detect
   * bottlenecks (e.g. RDAP/WHOIS queue backing up during a large
   * pipeline run) without instrumenting every provider call.
   */
  metrics(): RateLimiterMetrics {
    this.#refill();
    return {
      maxTokens: this.#maxTokens === Number.POSITIVE_INFINITY ? -1 : this.#maxTokens,
      currentTokens: this.#tokens === Number.POSITIVE_INFINITY ? -1 : this.#tokens,
      queueLength: this.#queue.length,
      maxQueueSize: this.#maxQueueSize,
      tokensPerInterval:
        this.#tokensPerInterval === Number.POSITIVE_INFINITY ? -1 : this.#tokensPerInterval,
      intervalMs: this.#intervalMs,
    };
  }

  async acquire(priority?: DnsPriority): Promise<void> {
    if (this.#tokensPerInterval === Number.POSITIVE_INFINITY) {
      return;
    }

    if (this.#maxQueueSize > 0 && this.#queue.length >= this.#maxQueueSize) {
      throw new RateLimiterQueueFullError(this.#queue.length, this.#maxQueueSize);
    }

    if (this.#maxQueueSize > 0 && this.#queue.length >= this.#maxQueueSize * 0.8) {
      getLogger().warn(
        { queueLength: this.#queue.length, maxQueueSize: this.#maxQueueSize },
        'Rate limiter queue above 80% capacity',
      );
    }

    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ resolve, reject, priority });
      if (!this.#processing) {
        void this.#processQueue();
      }
    });
  }

  async #processQueue(): Promise<void> {
    this.#processing = true;
    try {
      while (this.#queue.length > 0) {
        this.#refill();

        // Priority logic: consensus/tertiary can use reserved tokens
        // Primary must leave reserved tokens alone
        const entry = this.#queue[0];
        if (!entry) break;
        const isPriority = entry.priority === 'consensus' || entry.priority === 'tertiary';
        const availableTokens = isPriority
          ? this.getPriorityAvailableTokens()
          : this.getPrimaryAvailableTokens();

        if (availableTokens >= 1) {
          this.#tokens -= 1;
          this.#queue.shift()!.resolve();
        } else {
          const deficit = 1 - availableTokens;
          const waitMs = Math.ceil((deficit / this.#tokensPerInterval) * this.#intervalMs);
          await sleep(Math.max(waitMs, 1));
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

  #refill(): void {
    const now = Date.now();
    const elapsed = now - this.#lastRefill;
    const tokensToAdd = (elapsed / this.#intervalMs) * this.#tokensPerInterval;
    if (tokensToAdd >= 0.001) {
      this.#tokens = Math.min(this.#maxTokens, this.#tokens + tokensToAdd);
      this.#lastRefill = now;
    }
  }
}

/**
 * Priority-aware RateLimiter that reserves a fraction of tokens for
 * consensus/tertiary DNS legs (ADR-0067). When the shared DNS rate limiter
 * is used, a heavy primary run can exhaust all tokens and starve the
 * verification legs. This subclass reserves tokens based on
 * DNS_CONSENSUS_PRIORITY_RESERVED_RATIO.
 */
export class PriorityRateLimiter extends RateLimiter {
  readonly #reservedRatio: number;

  constructor(config: RateLimiterConfig, reservedRatio: number = 0.3) {
    super(config);
    this.#reservedRatio = Math.min(Math.max(reservedRatio, 0), 0.5);
  }

  protected override getReservedTokens(): number {
    return Math.floor(this.getMaxTokens() * this.#reservedRatio);
  }
}

/**
 * Creates a priority-aware rate limiter for DNS consensus.
 * Uses DNS_CONSENSUS_RATE_LIMIT_* config and DNS_CONSENSUS_PRIORITY_RESERVED_RATIO.
 */
export function createDnsConsensusRateLimiter(
  tokens: number,
  intervalMs: number,
  reservedRatio: number = 0.3,
): PriorityRateLimiter {
  return new PriorityRateLimiter(
    { maxTokens: tokens, tokensPerInterval: tokens, intervalMs },
    reservedRatio,
  );
}
