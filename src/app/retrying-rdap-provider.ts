import type { RdapResult } from '../types/domain-status.js';
import type { RdapProvider } from '../providers/rdap/rdap-provider.js';
import { isTransient } from './retrying-trademark-provider.js';
import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER,
  type CircuitBreakerPolicy,
} from './circuit-breaker.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
  jitterRatio: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const RDAP_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 500,
  backoffMultiplier: 2,
  maxDelayMs: 2000,
  jitterRatio: 0.5,
};

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  readonly circuitState: string;

  constructor(retryAfterMs: number, circuitState: string) {
    super(`RDAP provider circuit is ${circuitState}. Retry after ${retryAfterMs}ms.`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
    this.circuitState = circuitState;
  }
}

export class RetryingRdapProvider implements RdapProvider {
  readonly name: string;
  readonly #delegate: RdapProvider;
  readonly #policy: RetryPolicy;
  readonly #circuitBreaker: CircuitBreaker;
  readonly #cooldownMs: number;

  constructor(
    delegate: RdapProvider,
    policy: Partial<RetryPolicy> = {},
    circuitBreakerPolicy: Partial<CircuitBreakerPolicy> = {},
  ) {
    this.#delegate = delegate;
    this.#policy = { ...RDAP_RETRY_POLICY, ...policy };
    const cbPolicy = { ...DEFAULT_CIRCUIT_BREAKER, ...circuitBreakerPolicy };
    this.#circuitBreaker = new CircuitBreaker(cbPolicy);
    this.#cooldownMs = cbPolicy.cooldownMs;
    this.name = `RetryingRdapProvider(${delegate.name})`;
  }

  async confirm(domain: string, signal?: AbortSignal): Promise<RdapResult> {
    if (!this.#circuitBreaker.allow()) {
      throw new CircuitOpenError(this.#cooldownMs, this.#circuitBreaker.state);
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

function computeDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const exp = Math.pow(policy.backoffMultiplier, attempt - 1);
  const raw = policy.baseDelayMs * exp;
  const capped = Math.min(raw, policy.maxDelayMs);
  const lower = capped * (1 - policy.jitterRatio);
  const jittered = lower + random() * (capped - lower);
  return Math.max(0, Math.floor(jittered));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
