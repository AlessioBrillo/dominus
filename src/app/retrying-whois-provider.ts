// SPDX-License-Identifier: AGPL-3.0-only
import type {
  WhoisProvider,
  WhoisResult,
  WhoisCheckOptions,
} from '../providers/whois/whois-provider.js';
import { type RetryPolicy } from '../providers/retry-policy.js';
import { type CircuitBreakerPolicy, type ICircuitBreaker } from '../providers/circuit-breaker.js';
import { RetryingProvider } from '../providers/retry-utils.js';

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
  readonly #retrying: RetryingProvider<WhoisProvider>;

  constructor(
    delegate: WhoisProvider,
    policy: Partial<RetryPolicy> = {},
    circuitBreakerOrPolicy?: ICircuitBreaker | Partial<CircuitBreakerPolicy>,
  ) {
    this.#retrying = new RetryingProvider(delegate, 'WHOIS', {
      defaultPolicy: WHOIS_RETRY_POLICY,
      defaultBreaker: WHOIS_CIRCUIT_BREAKER,
      policy,
      circuitBreaker: circuitBreakerOrPolicy,
    });
  }

  checkAvailability(
    domain: string,
    signal?: AbortSignal,
    options?: WhoisCheckOptions,
  ): Promise<WhoisResult> {
    return this.#retrying.run((d, s) => d.checkAvailability(domain, s, options), signal);
  }
}
