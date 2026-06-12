import type {
  TrademarkMatch,
  TrademarkProvider,
} from '../providers/trademark/trademark-provider.js';
import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER,
  type CircuitBreakerPolicy,
} from './circuit-breaker.js';

/**
 * Configurable retry policy for {@link RetryingTrademarkProvider}.
 *
 * Defaults: 3 attempts, 250ms base delay, 2x backoff, full jitter,
 * 4-second ceiling per delay. Retries are triggered only on
 * "transient" outcomes — see {@link isTransient}.
 */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
  /** Random jitter in [0, 1) applied to each computed delay. */
  jitterRatio: number;
  /** Hook used to read the current jitter (overridable in tests). */
  random?: () => number;
  /** Hook used to wait between attempts (overridable in tests). */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  backoffMultiplier: 2,
  maxDelayMs: 4000,
  jitterRatio: 1,
};

/**
 * Decide whether an error from a trademark provider is worth retrying.
 *
 * The free public APIs (USPTO TSDR, EUIPO eSearch) return HTTP 5xx on
 * transient backend failures and HTTP 429 on rate-limit bursts; both
 * are retried. Network errors (DNS, ECONNRESET, fetch failures) are
 * also retried. 4xx other than 429 — and any error with a structured
 * payload — bubble up immediately.
 *
 * Detection strategy (in order of reliability):
 *  1. Numeric `status` or `statusCode` property (HTTP response).
 *  2. System `code` property (e.g. ECONNRESET, ETIMEDOUT).
 *  3. Message substring (fallback for wrapped/bare errors).
 *  4. Walks `cause` chain for wrapped errors that carry the above.
 */
export function isTransient(err: unknown): boolean {
  return isTransientInternal(err, new Set());
}

function isTransientInternal(err: unknown, seen: Set<unknown>): boolean {
  if (err === null || err === undefined || typeof err !== 'object' || seen.has(err)) {
    return false;
  }
  seen.add(err);

  const status =
    ((err as Record<string, unknown>).status as number | undefined) ??
    ((err as Record<string, unknown>).statusCode as number | undefined);

  if (typeof status === 'number') {
    if (status === 429 || (status >= 500 && status < 600)) return true;
  }

  const code = (err as Record<string, unknown>).code;
  if (typeof code === 'string') {
    const c = code.toUpperCase();
    if (
      c === 'ECONNRESET' ||
      c === 'ETIMEDOUT' ||
      c === 'ENOTFOUND' ||
      c === 'EAI_AGAIN' ||
      c === 'ECONNREFUSED' ||
      c === 'ENETUNREACH'
    ) {
      return true;
    }
  }

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    const wordBound = (s: string): boolean => {
      const re = new RegExp(`\\b${s}\\b`, 'i');
      return re.test(msg);
    };
    if (
      wordBound('429') ||
      wordBound('500') ||
      wordBound('502') ||
      wordBound('503') ||
      wordBound('504')
    )
      return true;
    if (
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('enotfound') ||
      msg.includes('eai_again') ||
      msg.includes('econnrefused') ||
      msg.includes('enetunreach')
    )
      return true;
    if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('timeout'))
      return true;

    if ('cause' in err && err.cause !== undefined && err.cause !== null) {
      return isTransientInternal(err.cause, seen);
    }
  }

  return false;
}

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
    // Fast-fail when the circuit is open
    if (!this.#circuitBreaker.allow()) {
      throw new CircuitOpenError(this.#circuitBreakerPolicy.cooldownMs, this.#circuitBreaker.state);
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

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  readonly circuitState: string;

  constructor(retryAfterMs: number, circuitState: string) {
    super(`Trademark provider circuit is ${circuitState}. Retry after ${retryAfterMs}ms.`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
    this.circuitState = circuitState;
  }
}

function computeDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  // Attempt 1 -> base * mult^0, attempt 2 -> base * mult^1, ...
  const exp = Math.pow(policy.backoffMultiplier, attempt - 1);
  const raw = policy.baseDelayMs * exp;
  const capped = Math.min(raw, policy.maxDelayMs);
  // Full jitter: random in [capped * (1 - jitterRatio), capped]
  const lower = capped * (1 - policy.jitterRatio);
  const jittered = lower + random() * (capped - lower);
  return Math.max(0, Math.floor(jittered));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
