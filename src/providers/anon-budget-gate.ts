// SPDX-License-Identifier: AGPL-3.0-only
import type { RateLimiterLike } from './rate-limiter.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface AnonBudgetGateConfig {
  /** When false the gate grants every attempt without touching the limiter
   *  (community edition default — anonymous scoring behaves as before). */
  enabled: boolean;
  /** Maximum wall time in ms to wait for a budget slot before failing open. */
  acquireTimeoutMs: number;
}

/**
 * Bounded budget for trademark checks triggered by anonymous (public)
 * valuations (ADR-0056). The public scoring namespace must not be able to
 * starve pipeline runs of USPTO/EUIPO capacity: it draws from its own
 * dedicated token bucket instead of the shared provider buckets.
 *
 * The gate is deliberately fail-open. A valuation that cannot obtain a slot
 * within `acquireTimeoutMs` — budget exhausted, queue full, limiter error —
 * returns false and the caller reports an 'unverified' trademark verdict
 * (buy signal stripped). The public surface degrades gracefully while
 * provider cost stays bounded, and the pipeline's fail-closed trademark
 * semantics (ADR-0006) are untouched.
 */
export class AnonBudgetGate {
  readonly #limiter: RateLimiterLike;
  readonly #enabled: boolean;
  readonly #acquireTimeoutMs: number;

  constructor(limiter: RateLimiterLike, config: AnonBudgetGateConfig) {
    this.#limiter = limiter;
    this.#enabled = config.enabled;
    this.#acquireTimeoutMs = config.acquireTimeoutMs;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Burst capacity of the wrapped budget (-1 when unlimited). */
  get maxTokens(): number {
    return this.#limiter.maxTokens === Number.POSITIVE_INFINITY ? -1 : this.#limiter.maxTokens;
  }

  /** The wrapped limiter, exposed for introspection (operator tooling). */
  get limiter(): RateLimiterLike {
    return this.#limiter;
  }

  /**
   * Try to acquire a trademark-gate budget slot.
   *
   * Returns true when a slot was granted, false when the budget could not
   * grant one in time — the caller must fail open to an 'unverified'
   * verdict. Never throws.
   */
  async tryAcquire(): Promise<boolean> {
    if (!this.#enabled) return true;
    if (this.#limiter.maxTokens === Number.POSITIVE_INFINITY) return true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Both race legs handle their own rejection so a late limiter failure
      // after the timeout has already fired can never surface as an
      // unhandled rejection.
      const slot = this.#limiter.acquire().then(
        () => true,
        () => false,
      );
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.#acquireTimeoutMs);
      });
      const granted = await Promise.race([slot, timeout]);
      if (!granted) {
        logger.warn('Anonymous trademark budget exhausted; failing open to unverified');
      }
      return granted;
    } catch (err) {
      logger.warn({ err }, 'Anonymous trademark budget unavailable; failing open to unverified');
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
