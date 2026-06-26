import type {
  TrademarkMatch,
  TrademarkProvider,
} from '../providers/trademark/trademark-provider.js';
import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER,
  type CircuitBreakerPolicy,
} from '../providers/circuit-breaker.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../providers/retry-policy.js';
import { withRetryAndCircuitBreaker } from '../providers/retry-utils.js';

/**
 * Retry decorator with circuit breaker for TrademarkProvider.
 *
 * Wraps a real provider and retries on transient errors with capped
 * exponential backoff and full jitter. Non-transient errors (e.g. a
 * well-formed 4xx response with a structured error payload) bubble up
 * immediately so the trademark gate can mark the source as Down/Up
 * correctly.
 *
 * A circuit breaker is layered on top of retries: after
 * `failureThreshold` consecutive transient failures within the
 * window, the circuit opens and all calls fail fast for `cooldownMs`.
 * This prevents hammering rate-limited free APIs (USPTO, EUIPO) when
 * they are degraded.
 *
 * Intended to be placed *inside* the CachedTrademarkProvider chain
 * (closer to the network than the cache) so cache hits never trigger
 * a retry loop and a transient error on the live call is retried
 * before it gets a chance to be cached as a failure.
 */
export class RetryingTrademarkProvider implements TrademarkProvider {
  readonly #delegate: TrademarkProvider;
  readonly #policy: RetryPolicy;
  readonly #circuitBreaker: CircuitBreaker;

  constructor(
    delegate: TrademarkProvider,
    policy: Partial<RetryPolicy> = {},
    circuitBreakerPolicy: Partial<CircuitBreakerPolicy> = {},
  ) {
    this.#delegate = delegate;
    this.#policy = { ...DEFAULT_RETRY_POLICY, ...policy };
    this.#circuitBreaker = new CircuitBreaker({
      ...DEFAULT_CIRCUIT_BREAKER,
      ...circuitBreakerPolicy,
    });
  }

  async search(term: string, signal?: AbortSignal): Promise<TrademarkMatch[]> {
    return withRetryAndCircuitBreaker(
      (s) => this.#delegate.search(term, s),
      'Trademark',
      { policy: this.#policy, circuitBreaker: this.#circuitBreaker },
      signal,
    );
  }
}
