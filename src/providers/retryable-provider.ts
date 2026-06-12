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

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  backoffMultiplier: 2,
  maxDelayMs: 2000,
  jitterRatio: 1,
};

export interface RetryableProvider<T, A extends unknown[]> {
  execute(...args: A): Promise<T>;
}

export function isTransientError(err: unknown): boolean {
  if (err === null || err === undefined || typeof err !== 'object') return false;

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
    if (
      msg.includes('429') ||
      msg.includes('503') ||
      msg.includes('502') ||
      msg.includes('504') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('enotfound') ||
      msg.includes('eai_again') ||
      msg.includes('econnrefused') ||
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('timeout')
    )
      return true;

    if ('cause' in err && err.cause !== undefined && err.cause !== null) {
      return isTransientError(err.cause);
    }
  }

  return false;
}

export async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  label: string,
  policy: Partial<RetryPolicy> = {},
  signal?: AbortSignal,
): Promise<T> {
  const p: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...policy };
  const random = p.random ?? Math.random;
  const sleep = p.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const max = Math.max(1, p.maxAttempts);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await fn(signal);
    } catch (err) {
      lastErr = err;
      if (attempt >= max || !isTransientError(err)) {
        throw err;
      }
      const exp = Math.pow(p.backoffMultiplier, attempt - 1);
      const raw = p.baseDelayMs * exp;
      const capped = Math.min(raw, p.maxDelayMs);
      const lower = capped * (1 - p.jitterRatio);
      const delay = Math.max(0, Math.floor(lower + random() * (capped - lower)));
      logger.warn(
        { err, label, attempt, max, delayMs: delay },
        `RetryableProvider: ${label} attempt ${attempt}/${max} failed, retrying in ${delay}ms`,
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

export function wrapWithRetry<T, A extends unknown[]>(
  fn: (...args: A) => Promise<T>,
  label: string,
  policy: Partial<RetryPolicy> = {},
): (...args: A) => Promise<T> {
  const wrapper: (...args: A) => Promise<T> = (...args: A): Promise<T> =>
    withRetry(() => fn(...args), label, policy);
  return wrapper;
}
