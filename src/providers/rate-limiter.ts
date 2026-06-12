export interface RateLimiterConfig {
  maxTokens: number;
  tokensPerInterval: number;
  intervalMs: number;
}

export interface RateLimiterMetrics {
  /** Maximum burst capacity. */
  maxTokens: number;
  /** Current available tokens. */
  currentTokens: number;
  /** Number of requests waiting in the queue. */
  queueLength: number;
  /** Tokens added per interval. */
  tokensPerInterval: number;
  /** Refill interval in milliseconds. */
  intervalMs: number;
}

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
}

export class RateLimiter {
  readonly #maxTokens: number;
  readonly #tokensPerInterval: number;
  readonly #intervalMs: number;
  #tokens: number;
  #lastRefill: number;
  #queue: QueuedAcquire[] = [];
  #processing = false;

  constructor(config: RateLimiterConfig) {
    this.#maxTokens = config.maxTokens;
    this.#tokensPerInterval = config.tokensPerInterval;
    this.#intervalMs = config.intervalMs;
    this.#tokens = config.maxTokens;
    this.#lastRefill = Date.now();
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
      tokensPerInterval:
        this.#tokensPerInterval === Number.POSITIVE_INFINITY ? -1 : this.#tokensPerInterval,
      intervalMs: this.#intervalMs,
    };
  }

  async acquire(): Promise<void> {
    if (this.#tokensPerInterval === Number.POSITIVE_INFINITY) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.#queue.push({ resolve });
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
        if (this.#tokens >= 1) {
          this.#tokens -= 1;
          const entry = this.#queue.shift()!;
          entry.resolve();
        } else {
          const deficit = 1 - this.#tokens;
          const waitMs = Math.ceil((deficit / this.#tokensPerInterval) * this.#intervalMs);
          await sleep(Math.max(waitMs, 1));
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
