import { getLogger } from '../logger.js';
import {
  isTransient,
  computeDelay,
  defaultSleep,
  CircuitOpenError,
  type RetryPolicy,
} from './retry-policy.js';
import { type ICircuitBreaker } from './circuit-breaker.js';

const logger = getLogger();

export interface RetryAndCircuitBreakerOptions {
  policy: RetryPolicy;
  circuitBreaker: ICircuitBreaker;
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
