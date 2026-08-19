// SPDX-License-Identifier: AGPL-3.0-only
import type { RdapResult } from '../types/domain-status.js';
import type { RdapProvider } from '../providers/rdap/rdap-provider.js';
import { type RetryPolicy } from '../providers/retry-policy.js';
import {
  DEFAULT_CIRCUIT_BREAKER,
  type CircuitBreakerPolicy,
  type ICircuitBreaker,
} from '../providers/circuit-breaker.js';
import { RetryingProvider } from '../providers/retry-utils.js';

const RDAP_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 500,
  backoffMultiplier: 2,
  maxDelayMs: 2000,
  jitterRatio: 0.5,
};

export class RetryingRdapProvider implements RdapProvider {
  readonly name: string;
  readonly #retrying: RetryingProvider<RdapProvider>;

  constructor(
    delegate: RdapProvider,
    policy: Partial<RetryPolicy> = {},
    circuitBreakerOrPolicy?: ICircuitBreaker | Partial<CircuitBreakerPolicy>,
  ) {
    this.#retrying = new RetryingProvider(delegate, 'RDAP', {
      defaultPolicy: RDAP_RETRY_POLICY,
      defaultBreaker: DEFAULT_CIRCUIT_BREAKER,
      policy,
      circuitBreaker: circuitBreakerOrPolicy,
    });
    this.name = `RetryingRdapProvider(${delegate.name})`;
  }

  confirm(domain: string, signal?: AbortSignal): Promise<RdapResult> {
    return this.#retrying.run((d, s) => d.confirm(domain, s), signal);
  }
}
