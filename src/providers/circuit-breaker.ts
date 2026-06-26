export interface CircuitBreakerPolicy {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerPolicy = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 120_000,
};

export const USPTO_CIRCUIT_BREAKER: CircuitBreakerPolicy = {
  failureThreshold: 3,
  windowMs: 30_000,
  cooldownMs: 60_000,
};

/**
 * EUIPO has a more aggressive rate-limiter (X-IBM-Client-Id quota)
 * and higher latency (OAuth2 token exchange before each search).
 * A more conservative breaker protects the free-tier quota.
 */
export const EUIPO_CIRCUIT_BREAKER: CircuitBreakerPolicy = {
  failureThreshold: 4,
  windowMs: 60_000,
  cooldownMs: 120_000,
};

/**
 * RDAP bootstrap servers (rdap.org, Verisign, Google) are generally reliable
 * but can rate-limit under sustained load. A moderate circuit breaker prevents
 * burning through all failover servers during transient degradation.
 */
export const RDAP_CIRCUIT_BREAKER: CircuitBreakerPolicy = {
  failureThreshold: 10,
  windowMs: 60_000,
  cooldownMs: 30_000,
};

type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  #state: CircuitState = 'closed';
  #failureCount = 0;
  #windowStart = 0;
  #openedAt = 0;
  readonly #policy: CircuitBreakerPolicy;

  constructor(policy: Partial<CircuitBreakerPolicy> = {}) {
    this.#policy = { ...DEFAULT_CIRCUIT_BREAKER, ...policy };
  }

  allow(): boolean {
    if (this.#state === 'closed') return true;

    if (this.#state === 'open') {
      if (Date.now() - this.#openedAt >= this.#policy.cooldownMs) {
        this.#state = 'half-open';
        return true;
      }
      return false;
    }

    return true;
  }

  onSuccess(): void {
    this.#state = 'closed';
    this.#failureCount = 0;
    this.#windowStart = 0;
  }

  onFailure(): void {
    const now = Date.now();

    if (this.#windowStart === 0 || now - this.#windowStart > this.#policy.windowMs) {
      this.#failureCount = 1;
      this.#windowStart = now;
    } else {
      this.#failureCount++;
    }

    if (this.#failureCount >= this.#policy.failureThreshold) {
      this.#state = 'open';
      this.#openedAt = now;
    } else if (this.#state === 'half-open') {
      this.#state = 'open';
      this.#openedAt = now;
    }
  }

  get state(): CircuitState {
    return this.#state;
  }

  get cooldownMs(): number {
    return this.#policy.cooldownMs;
  }

  reset(): void {
    this.#state = 'closed';
    this.#failureCount = 0;
    this.#windowStart = 0;
    this.#openedAt = 0;
  }
}
