/**
 * Configurable retry policy for provider-level retry decorators.
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
 * Decide whether an error from a network provider is worth retrying.
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

export function computeDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const exp = Math.pow(policy.backoffMultiplier, attempt - 1);
  const raw = policy.baseDelayMs * exp;
  const capped = Math.min(raw, policy.maxDelayMs);
  const lower = capped * (1 - policy.jitterRatio);
  const jittered = lower + random() * (capped - lower);
  return Math.max(0, Math.floor(jittered));
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Error thrown when a circuit breaker is open and calls are
 * being rejected without attempting the network operation.
 */
export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  readonly circuitState: string;

  constructor(providerLabel: string, retryAfterMs: number, circuitState: string) {
    super(`${providerLabel} circuit is ${circuitState}. Retry after ${retryAfterMs}ms.`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
    this.circuitState = circuitState;
  }
}
