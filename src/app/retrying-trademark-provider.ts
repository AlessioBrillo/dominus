import type {
  TrademarkMatch,
  TrademarkProvider,
} from '../providers/trademark/trademark-provider.js';

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
 * payload — bubble up unchanged.
 */
export function isTransient(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('429')) return true;
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504'))
      return true;
    if (
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('enotfound') ||
      msg.includes('eai_again')
    )
      return true;
    if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('timeout'))
      return true;
  }
  return false;
}

/**
 * Retry decorator for TrademarkProvider.
 *
 * Wraps a real provider and retries on transient errors with capped
 * exponential backoff and full jitter. Non-transient errors (e.g. a
 * well-formed 4xx response with a structured error payload) bubble up
 * immediately so the trademark gate can mark the source as Down/Up
 * correctly.
 *
 * Intended to be placed *inside* the CachedTrademarkProvider chain
 * (closer to the network than the cache) so cache hits never trigger
 * a retry loop and a transient error on the live call is retried
 * before it gets a chance to be cached as a failure.
 */
export class RetryingTrademarkProvider implements TrademarkProvider {
  readonly #delegate: TrademarkProvider;
  readonly #policy: RetryPolicy;

  constructor(delegate: TrademarkProvider, policy: Partial<RetryPolicy> = {}) {
    this.#delegate = delegate;
    this.#policy = { ...DEFAULT_RETRY_POLICY, ...policy };
  }

  async search(term: string): Promise<TrademarkMatch[]> {
    const random = this.#policy.random ?? Math.random;
    const sleep = this.#policy.sleep ?? defaultSleep;
    const max = Math.max(1, this.#policy.maxAttempts);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= max; attempt++) {
      try {
        return await this.#delegate.search(term);
      } catch (err) {
        lastErr = err;
        if (attempt >= max || !isTransient(err)) {
          throw err;
        }
        const delay = computeDelay(attempt, this.#policy, random);
        await sleep(delay);
      }
    }
    // Defensive: the loop above always returns or throws. This line is
    // unreachable but satisfies the no-implicit-return contract.
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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
