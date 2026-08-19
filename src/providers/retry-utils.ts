// SPDX-License-Identifier: AGPL-3.0-only
import { getLogger } from '../logger.js';
import {
  isTransient,
  computeDelay,
  defaultSleep,
  CircuitOpenError,
  type RetryPolicy,
} from './retry-policy.js';
import {
  CircuitBreaker,
  type CircuitBreakerPolicy,
  type ICircuitBreaker,
} from './circuit-breaker.js';

const logger = getLogger();

export interface RetryAndCircuitBreakerOptions {
  policy: RetryPolicy;
  circuitBreaker: ICircuitBreaker;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  backoffMultiplier: 2,
  maxDelayMs: 2000,
  jitterRatio: 1,
};

/** Retry `fn` on transient errors with capped exponential backoff and full
 * jitter. No circuit breaker — used where a breaker exists at another level
 * (e.g. per-resolver-group DNS breakers). */
export async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  label: string,
  policy: Partial<RetryPolicy> = {},
  signal?: AbortSignal,
): Promise<T> {
  const p: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...policy };
  const random = p.random ?? Math.random;
  const sleep = p.sleep ?? defaultSleep;
  const max = Math.max(1, p.maxAttempts);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await fn(signal);
    } catch (err) {
      lastErr = err;
      if (attempt >= max || !isTransient(err)) throw err;
      const delay = computeDelay(attempt, p, random);
      logger.warn(
        { err, label, attempt, max, delayMs: delay },
        `Retryable: ${label} attempt ${attempt}/${max} failed, retrying in ${delay}ms`,
      );
      await Promise.race([
        sleep(delay),
        signal
          ? new Promise<never>((_, reject) => {
              if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
              signal.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true },
              );
            })
          : Promise.resolve(),
      ]);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Stateful retry + circuit-breaker decorator shared by the provider
 * wrappers. Each wrapper implements its provider interface and delegates
 * to this class with its own defaults. */
export class RetryingProvider<TDelegate> {
  readonly #delegate: TDelegate;
  readonly #label: string;
  readonly #policy: RetryPolicy;
  readonly #circuitBreaker: ICircuitBreaker;

  constructor(
    delegate: TDelegate,
    label: string,
    options: {
      defaultPolicy: RetryPolicy;
      defaultBreaker: CircuitBreakerPolicy;
      policy?: Partial<RetryPolicy> | undefined;
      circuitBreaker?: ICircuitBreaker | Partial<CircuitBreakerPolicy> | undefined;
    },
  ) {
    this.#delegate = delegate;
    this.#label = label;
    this.#policy = { ...options.defaultPolicy, ...options.policy };
    this.#circuitBreaker =
      options.circuitBreaker && 'allow' in options.circuitBreaker
        ? (options.circuitBreaker as ICircuitBreaker)
        : new CircuitBreaker({
            ...options.defaultBreaker,
            ...(options.circuitBreaker as Partial<CircuitBreakerPolicy>),
          });
  }

  run<T>(
    invoke: (delegate: TDelegate, signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return withRetryAndCircuitBreaker(
      (s) => invoke(this.#delegate, s),
      this.#label,
      { policy: this.#policy, circuitBreaker: this.#circuitBreaker },
      signal,
    );
  }
}

export async function withRetryAndCircuitBreaker<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  label: string,
  options: RetryAndCircuitBreakerOptions,
  signal?: AbortSignal,
): Promise<T> {
  const { policy, circuitBreaker } = options;

  const allowed = await circuitBreaker.allow();
  if (!allowed) {
    throw new CircuitOpenError(label, circuitBreaker.cooldownMs, circuitBreaker.state);
  }

  const random = policy.random ?? Math.random;
  const sleep = policy.sleep ?? defaultSleep;
  const max = Math.max(1, policy.maxAttempts);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await fn(signal);
      await circuitBreaker.onSuccess();
      return result;
    } catch (err) {
      lastErr = err;
      if (err instanceof CircuitOpenError) throw err;
      if (attempt >= max || !isTransient(err)) {
        await circuitBreaker.onFailure();
        if (attempt >= max && isTransient(err)) {
          logger.warn(
            { label, attempt, max, err },
            `${label} transient failure after all retries — circuit opened`,
          );
        }
        throw err;
      }
      const delay = computeDelay(attempt, policy, random);
      logger.debug({ label, attempt, delayMs: delay }, `${label} retry`);
      await sleep(delay);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
