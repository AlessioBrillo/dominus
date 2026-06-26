import type { RdapResult } from '../types/domain-status.js';
import type { RdapProvider } from '../providers/rdap/rdap-provider.js';
import { type RetryPolicy } from '../providers/retry-policy.js';
import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER,
  type CircuitBreakerPolicy,
} from '../providers/circuit-breaker.js';
import { withRetryAndCircuitBreaker } from '../providers/retry-utils.js';

const RDAP_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 500,
  backoffMultiplier: 2,
  maxDelayMs: 2000,
  jitterRatio: 0.5,
};

export class RetryingRdapProvider implements RdapProvider {
  readonly name: string;
  readonly #delegate: RdapProvider;
  readonly #policy: RetryPolicy;
  readonly #circuitBreaker: CircuitBreaker;

  constructor(
    delegate: RdapProvider,
    policy: Partial<RetryPolicy> = {},
    circuitBreakerPolicy: Partial<CircuitBreakerPolicy> = {},
  ) {
    this.#delegate = delegate;
    this.#policy = { ...RDAP_RETRY_POLICY, ...policy };
    this.#circuitBreaker = new CircuitBreaker({
      ...DEFAULT_CIRCUIT_BREAKER,
      ...circuitBreakerPolicy,
    });
    this.name = `RetryingRdapProvider(${delegate.name})`;
  }

  async confirm(domain: string, signal?: AbortSignal): Promise<RdapResult> {
    return withRetryAndCircuitBreaker(
      (s) => this.#delegate.confirm(domain, s),
      'RDAP',
      { policy: this.#policy, circuitBreaker: this.#circuitBreaker },
      signal,
    );
  }
}
