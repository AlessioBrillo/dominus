import type { WhoisProvider, WhoisResult } from '../providers/whois/whois-provider.js';
import { type RetryPolicy } from '../providers/retry-policy.js';
import { CircuitBreaker, type CircuitBreakerPolicy } from '../providers/circuit-breaker.js';
import { withRetryAndCircuitBreaker } from '../providers/retry-utils.js';

export const WHOIS_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 4000,
  jitterRatio: 0.5,
};

export const WHOIS_CIRCUIT_BREAKER: CircuitBreakerPolicy = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 120_000,
};

export class RetryingWhoisProvider implements WhoisProvider {
  readonly #delegate: WhoisProvider;
  readonly #policy: RetryPolicy;
  readonly #circuitBreaker: CircuitBreaker;

  constructor(
    delegate: WhoisProvider,
    policy: Partial<RetryPolicy> = {},
    circuitBreakerPolicy: Partial<CircuitBreakerPolicy> = {},
  ) {
    this.#delegate = delegate;
    this.#policy = { ...WHOIS_RETRY_POLICY, ...policy };
    this.#circuitBreaker = new CircuitBreaker({
      ...WHOIS_CIRCUIT_BREAKER,
      ...circuitBreakerPolicy,
    });
  }

  async checkAvailability(domain: string, signal?: AbortSignal): Promise<WhoisResult> {
    return withRetryAndCircuitBreaker(
      (s) => this.#delegate.checkAvailability(domain, s),
      'WHOIS',
      { policy: this.#policy, circuitBreaker: this.#circuitBreaker },
      signal,
    );
  }
}
