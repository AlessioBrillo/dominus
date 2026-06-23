import type { RdapResult } from '../types/domain-status.js';
import type { RdapProvider } from '../providers/rdap/rdap-provider.js';
import {
  isTransient,
  computeDelay,
  defaultSleep,
  CircuitOpenError,
  type RetryPolicy,
} from '../providers/retry-policy.js';
import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER,
  type CircuitBreakerPolicy,
} from './circuit-breaker.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

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
  readonly #circuitBreakerPolicy: CircuitBreakerPolicy;

  constructor(
    delegate: RdapProvider,
    policy: Partial<RetryPolicy> = {},
    circuitBreakerPolicy: Partial<CircuitBreakerPolicy> = {},
  ) {
    this.#delegate = delegate;
    this.#policy = { ...RDAP_RETRY_POLICY, ...policy };
    this.#circuitBreakerPolicy = { ...DEFAULT_CIRCUIT_BREAKER, ...circuitBreakerPolicy };
    this.#circuitBreaker = new CircuitBreaker(this.#circuitBreakerPolicy);
    this.name = `RetryingRdapProvider(${delegate.name})`;
  }

  async confirm(domain: string, signal?: AbortSignal): Promise<RdapResult> {
    if (!this.#circuitBreaker.allow()) {
      throw new CircuitOpenError('RDAP provider', this.#circuitBreakerPolicy.cooldownMs, this.#circuitBreaker.state);
    }

    const random = this.#policy.random ?? Math.random;
    const sleep = this.#policy.sleep ?? defaultSleep;
    const max = Math.max(1, this.#policy.maxAttempts);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= max; attempt++) {
      try {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const result = await this.#delegate.confirm(domain, signal);
        this.#circuitBreaker.onSuccess();
        return result;
      } catch (err) {
        lastErr = err;
        if (err instanceof CircuitOpenError) throw err;
        if (attempt >= max || !isTransient(err)) {
          this.#circuitBreaker.onFailure();
          if (isTransient(err)) {
            logger.warn(
              { domain, attempt, max, err },
              'RDAP transient failure after all retries — circuit opened',
            );
          }
          throw err;
        }
        const delay = computeDelay(attempt, this.#policy, random);
        logger.debug({ domain, attempt, delayMs: delay }, 'RDAP retry');
        await sleep(delay);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
