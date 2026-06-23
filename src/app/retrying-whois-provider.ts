import type { WhoisProvider, WhoisResult } from '../providers/whois/whois-provider.js';
import {
  isTransient,
  computeDelay,
  defaultSleep,
  CircuitOpenError,
  type RetryPolicy,
} from '../providers/retry-policy.js';
import { CircuitBreaker, type CircuitBreakerPolicy } from './circuit-breaker.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

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
  readonly #circuitBreakerPolicy: CircuitBreakerPolicy;

  constructor(
    delegate: WhoisProvider,
    policy: Partial<RetryPolicy> = {},
    circuitBreakerPolicy: Partial<CircuitBreakerPolicy> = {},
  ) {
    this.#delegate = delegate;
    this.#policy = { ...WHOIS_RETRY_POLICY, ...policy };
    this.#circuitBreakerPolicy = { ...WHOIS_CIRCUIT_BREAKER, ...circuitBreakerPolicy };
    this.#circuitBreaker = new CircuitBreaker(this.#circuitBreakerPolicy);
  }

  async checkAvailability(domain: string, signal?: AbortSignal): Promise<WhoisResult> {
    if (!this.#circuitBreaker.allow()) {
      throw new CircuitOpenError(
        'WHOIS provider',
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
        const result = await this.#delegate.checkAvailability(domain, signal);
        this.#circuitBreaker.onSuccess();
        return result;
      } catch (err) {
        lastErr = err;
        if (attempt >= max || !isTransient(err)) {
          this.#circuitBreaker.onFailure();
          if (attempt >= max && isTransient(err)) {
            logger.warn(
              { domain, attempt, max, err },
              'WHOIS transient failure after all retries — circuit opened',
            );
          }
          throw err;
        }
        const delay = computeDelay(attempt, this.#policy, random);
        logger.debug({ domain, attempt, delayMs: delay }, 'WHOIS retry');
        await sleep(delay);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
