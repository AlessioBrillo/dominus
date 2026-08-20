// SPDX-License-Identifier: AGPL-3.0-only
import type {
  TrademarkMatch,
  TrademarkProvider,
} from '../providers/trademark/trademark-provider.js';
import {
  DEFAULT_CIRCUIT_BREAKER,
  type CircuitBreakerPolicy,
  type ICircuitBreaker,
} from '../providers/circuit-breaker.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../providers/retry-policy.js';
import { RetryingProvider } from '../providers/retry-utils.js';

/**
 * Retry decorator with circuit breaker for TrademarkProvider.
 *
 * Wraps a real provider and retries on transient errors with capped
 * exponential backoff and full jitter. A circuit breaker opens after
 * `failureThreshold` consecutive transient failures so degraded free
 * APIs (USPTO, EUIPO) fail fast instead of being hammered.
 *
 * Intended to be placed *inside* the CachedTrademarkProvider chain
 * (closer to the network than the cache) so cache hits never trigger
 * a retry loop. Accepts an in-memory CircuitBreaker or a
 * DistributedCircuitBreaker via the ICircuitBreaker interface.
 */
export class RetryingTrademarkProvider implements TrademarkProvider {
  readonly #retrying: RetryingProvider<TrademarkProvider>;

  constructor(
    delegate: TrademarkProvider,
    policy: Partial<RetryPolicy> = {},
    circuitBreakerOrPolicy?: ICircuitBreaker | Partial<CircuitBreakerPolicy>,
  ) {
    this.#retrying = new RetryingProvider(delegate, 'Trademark', {
      defaultPolicy: DEFAULT_RETRY_POLICY,
      defaultBreaker: DEFAULT_CIRCUIT_BREAKER,
      policy,
      circuitBreaker: circuitBreakerOrPolicy,
    });
  }

  search(term: string, signal?: AbortSignal): Promise<TrademarkMatch[]> {
    return this.#retrying.run((d, s) => d.search(term, s), signal);
  }
}
