export interface RateLimiterConfig {
  maxTokens: number;
  tokensPerInterval: number;
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

export class RateLimiter {
  readonly #maxTokens: number;
  readonly #tokensPerInterval: number;
  readonly #intervalMs: number;
  #tokens: number;
  #lastRefill: number;

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

  async acquire(): Promise<void> {
    if (this.#tokensPerInterval === Number.POSITIVE_INFINITY) {
      return;
    }

    while (true) {
      this.#refill();
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      const deficit = 1 - this.#tokens;
      const waitMs = Math.ceil((deficit / this.#tokensPerInterval) * this.#intervalMs);
      await sleep(Math.max(waitMs, 1));
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
