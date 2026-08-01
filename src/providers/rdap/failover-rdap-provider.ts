// SPDX-License-Identifier: AGPL-3.0-only
import type { RdapResult } from '../../types/domain-status.js';
import { ProviderError } from '../../types/errors.js';
import type { RdapProvider } from './rdap-provider.js';
import { PublicRdapProvider } from './public-rdap-provider.js';
import { type RateLimiterLike, RateLimiter } from '../rate-limiter.js';
import {
  CircuitBreaker,
  RDAP_PER_SERVER_CIRCUIT_BREAKER,
  type CircuitBreakerPolicy,
  type ICircuitBreaker,
} from '../circuit-breaker.js';

export interface RdapBootstrapConfig {
  baseUrl: string;
  name: string;
}

const DEFAULT_BOOTSTRAP_SERVERS: RdapBootstrapConfig[] = [
  { baseUrl: 'https://rdap.org/domain/', name: 'rdap.org' },
  { baseUrl: 'https://rdap.verisign.com/com/domain/', name: 'verisign-rdap' },
  { baseUrl: 'https://rdap.nic.google/domain/', name: 'google-rdap' },
];

/**
 * FailoverRdapProvider — parallel RDAP resolution with race-based failover
 * and per-server circuit breakers.
 *
 * Queries all bootstrap servers concurrently and returns the first successful
 * response. When one server responds, remaining in-flight requests are
 * cancelled via AbortController. If all servers fail, a ProviderError is
 * thrown with aggregated error messages.
 *
 * Each bootstrap server has its own circuit breaker. When a server degrades,
 * its breaker opens and it is skipped in subsequent confirm() calls without
 * waiting for a timeout. This isolates failure — one overloaded server does
 * not penalise the others.
 *
 * Parallel (not sequential) is deliberate:
 * - rdap.org is the most comprehensive but also the most commonly overloaded.
 *   Verisign's COM/NET RDAP and Google Registry RDAP often respond faster
 *   for their respective TLDs, so racing all three gives the lowest latency.
 * - With per-request abort propagation, the penalty for parallel queries is
 *   bounded by the fastest server's response time, not the slowest.
 * - A shared rate limiter ensures we don't exceed the configured global
 *   RDAP rate limit across all bootstrap servers combined.
 */
export class FailoverRdapProvider implements RdapProvider {
  readonly name: string;
  readonly #providers: RdapProvider[];
  readonly #sharedRateLimiter: RateLimiterLike;
  readonly #perServerBreakers: Map<string, ICircuitBreaker>;

  // Intra-run cache: avoids re-querying RDAP for the same domain within a
  // short window (TTL). This is critical because the pipeline may visit the
  // same domain multiple times (e.g., RDAP + WHOIS cross-validation retries
  // the same candidate). TTL is intentionally short (60s) — long enough to
  // cover a single pipeline run, short enough that stale data won't leak
  // across runs (cache is also cleared at run start via orchestrator hook).
  readonly #intraRunCache = new Map<string, { result: RdapResult; expiresAt: number }>();
  static readonly #INTRARUN_CACHE_TTL_MS = 60_000;

  constructor(
    providers?: RdapProvider[],
    sharedRateLimiter?: RateLimiterLike,
    perServerCircuitBreakerPolicy?: Partial<CircuitBreakerPolicy>,
  ) {
    if (providers) {
      this.#providers = providers;
      this.name = `FailoverRdapProvider(${providers.map((s) => s.name).join(',')})`;
    } else {
      this.#providers = DEFAULT_BOOTSTRAP_SERVERS.map(
        (cfg) => new PublicRdapProvider(cfg.baseUrl, cfg.name),
      );
      this.name = `FailoverRdapProvider(${DEFAULT_BOOTSTRAP_SERVERS.map((s) => s.name).join(',')})`;
    }
    this.#sharedRateLimiter = sharedRateLimiter ?? RateLimiter.unlimited();

    // Build per-server circuit breakers. Each server gets its own breaker
    // so that a degraded server is isolated from healthy ones.
    this.#perServerBreakers = new Map(
      this.#providers.map((p) => [
        p.name,
        new CircuitBreaker({
          ...RDAP_PER_SERVER_CIRCUIT_BREAKER,
          ...perServerCircuitBreakerPolicy,
        }),
      ]),
    );
  }

  /** Clear the intra-run cache. Called at pipeline run start. */
  clearCache(): void {
    this.#intraRunCache.clear();
  }

  /**
   * Create from custom URLs, sharing a single rate limiter across all servers.
   * A single rate limiter is preferred over per-server limiters because the
   * RDAP ecosystem as a whole should be rate-limited, not individual endpoints.
   */
  static fromConfig(
    urls: string[],
    rateLimiter?: RateLimiterLike,
    perServerCircuitBreakerPolicy?: Partial<CircuitBreakerPolicy>,
  ): FailoverRdapProvider {
    const providers = urls.map((url, i) => {
      const name = `rdap-server-${i + 1}`;
      return new PublicRdapProvider(url, name, RateLimiter.unlimited());
    });
    return new FailoverRdapProvider(providers, rateLimiter, perServerCircuitBreakerPolicy);
  }

  /**
   * Create with default bootstrap servers and a shared rate limiter.
   */
  static withDefaults(
    rateLimiter?: RateLimiterLike,
    perServerCircuitBreakerPolicy?: Partial<CircuitBreakerPolicy>,
  ): FailoverRdapProvider {
    const providers = DEFAULT_BOOTSTRAP_SERVERS.map(
      (cfg) => new PublicRdapProvider(cfg.baseUrl, cfg.name, RateLimiter.unlimited()),
    );
    return new FailoverRdapProvider(providers, rateLimiter, perServerCircuitBreakerPolicy);
  }

  async confirm(domain: string, signal?: AbortSignal): Promise<RdapResult> {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Check intra-run cache first — avoids redundant RDAP queries when the
    // pipeline revisits the same domain (cross-validation, retries).
    const now = Date.now();
    const cached = this.#intraRunCache.get(domain);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }

    // Use a single AbortController to cancel all in-flight requests
    // once the first server responds (winner aborts the rest).
    const winnerAc = new AbortController();
    const combinedSignal = signal ? AbortSignal.any([signal, winnerAc.signal]) : winnerAc.signal;

    // Wrap in the shared rate limiter so we only issue one RDAP request
    // per domain across all servers simultaneously (not one per server).
    return this.#sharedRateLimiter.throttle(async () => {
      const errors: string[] = [];
      const activeProviders: {
        provider: RdapProvider;
        promise: Promise<{ provider: string; result: RdapResult }>;
      }[] = [];

      for (const provider of this.#providers) {
        const breaker = this.#perServerBreakers.get(provider.name);

        // Skip servers whose circuit breaker is open — they are degraded
        // and would waste time on a timeout.
        if (breaker && !breaker.allow()) {
          errors.push(`${provider.name}: circuit open`);
          continue;
        }

        const promise = (async (): Promise<{ provider: string; result: RdapResult }> => {
          if (combinedSignal.aborted) throw new DOMException('Aborted', 'AbortError');
          try {
            const result = await provider.confirm(domain, combinedSignal);
            // First success wins — cancel all other in-flight requests
            if (!winnerAc.signal.aborted) {
              winnerAc.abort();
            }
            void breaker?.onSuccess();
            return { provider: provider.name, result };
          } catch (err) {
            // Only record circuit breaker failures for real errors, not
            // for cancellations caused by another server winning the race.
            const isAbort = err instanceof DOMException && err.name === 'AbortError';
            if (!isAbort) {
              void breaker?.onFailure();
            }
            throw err;
          }
        })();

        activeProviders.push({ provider, promise });
      }

      const promises = activeProviders.map((ap) => ap.promise);
      const settled = await Promise.allSettled(promises);

      for (let i = 0; i < activeProviders.length; i++) {
        const { provider } = activeProviders[i]!;
        const s = settled[i]!;

        if (s.status === 'fulfilled') {
          // Populate intra-run cache before returning
          const { result } = s.value;
          this.#intraRunCache.set(domain, {
            result,
            expiresAt: now + FailoverRdapProvider.#INTRARUN_CACHE_TTL_MS,
          });
          return s.value.result;
        }

        errors.push(
          `${provider.name}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
        );
      }

      throw new ProviderError(
        `All RDAP bootstrap servers failed for ${domain}: [${errors.join('; ')}]`,
        this.name,
      );
    });
  }
}
