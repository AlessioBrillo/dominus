import type {
  TrademarkMatch,
  TrademarkProvider,
} from '../providers/trademark/trademark-provider.js';
import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER,
  type CircuitBreakerPolicy,
} from './circuit-breaker.js';
import {
  DEFAULT_RETRY_POLICY,
  isTransient,
  computeDelay,
  defaultSleep,
  CircuitOpenError,
  type RetryPolicy,
} from '../providers/retry-policy.js';

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
  readonly #circuitBreakerPolicy: CircuitBreakerPolicy;

  constructor(
    delegate: TrademarkProvider,
    policy: Partial<RetryPolicy> = {},
    circuitBreakerPolicy: Partial<CircuitBreakerPolicy> = {},
  ) {
    this.#delegate = delegate;
    this.#policy = { ...DEFAULT_RETRY_POLICY, ...policy };
    this.#circuitBreakerPolicy = { ...DEFAULT_CIRCUIT_BREAKER, ...circuitBreakerPolicy };
    this.#circuitBreaker = new CircuitBreaker(this.#circuitBreakerPolicy);
  }

  async search(term: string, signal?: AbortSignal): Promise<TrademarkMatch[]> {
    if (!this.#circuitBreaker.allow()) {
      throw new CircuitOpenError(
        'Trademark provider',
        this.#circuitBreakerPolicy.cooldownMs,
        this.#circuitBreaker.state,
      );
    }

    const random = this.#policy.random ?? Math.random;
    const sleep = this.#policy.sleep ?? defaultSleep;
    const max = Math.max(1, this.#policy.maxAttempts);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= max; attempt++) {
      try {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const result = await this.#delegate.search(term, signal);
        this.#circuitBreaker.onSuccess();
        return result;
      } catch (err) {
        lastErr = err;
        if (attempt >= max || !isTransient(err)) {
          this.#circuitBreaker.onFailure();
          throw err;
        }
        const delay = computeDelay(attempt, this.#policy, random);
        await sleep(delay);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
