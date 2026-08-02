// SPDX-License-Identifier: AGPL-3.0-only
import { DomainStatus, type RdapResult } from '../../types/domain-status.js';
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
import { type IanaRdapBootstrap, RDAP_ORG_UNIVERSAL } from './rdap-bootstrap.js';
import { extractTld } from '../../utils/domain.js';

const DEFAULT_RDAP_TIMEOUT_MS = 10_000;

/**
 * FailoverRdapProvider — parallel RDAP resolution with race-based failover
 * and per-server circuit breakers.
 *
 * Queries the candidate servers concurrently and returns the first
 * *definitive* response (Available or Registered). An `Unknown` response
 * (rate-limit wait, server error, or a 404 from a server that is not
 * authoritative for the domain's TLD) never wins the race — the remaining
 * servers keep resolving. Only when every server answers Unknown is the
 * first Unknown returned (conservative: no fabricated availability). If all
 * servers fail outright, a ProviderError is thrown.
 *
 * Per-TLD server selection (RFC 7484): when an IANA bootstrap is supplied,
 * each domain resolves to its registry's authoritative RDAP server(s) plus
 * the rdap.org routing fallback. A 404 from an authoritative server means
 * "not registered"; a 404 from any other server is meaningless — the
 * bootstrap prevents such responses from being interpreted as availability.
 *
 * Each server has its own circuit breaker, isolating degraded servers.
 * The shared rate limiter is applied per request (each server acquires a
 * token), so the configured global RDAP rate limit covers the sum of all
 * requests.
 */
export class FailoverRdapProvider implements RdapProvider {
  readonly name: string;
  readonly #providers: RdapProvider[];
  readonly #sharedRateLimiter: RateLimiterLike;
  readonly #perServerBreakers: Map<string, ICircuitBreaker>;
  readonly #bootstrap: IanaRdapBootstrap | undefined;
  readonly #perTldProviders = new Map<string, RdapProvider[]>();

  // Intra-run cache: avoids re-querying RDAP for the same domain within a
  // short window (TTL). TTL is intentionally short (60s) — long enough to
  // cover a single pipeline run, short enough that stale data won't leak
  // across runs (cache is also cleared at run start via orchestrator hook).
  readonly #intraRunCache = new Map<string, { result: RdapResult; expiresAt: number }>();
  static readonly #INTRARUN_CACHE_TTL_MS = 60_000;

  constructor(
    providers?: RdapProvider[],
    sharedRateLimiter?: RateLimiterLike,
    perServerCircuitBreakerPolicy?: Partial<CircuitBreakerPolicy>,
    bootstrap?: IanaRdapBootstrap,
  ) {
    this.#providers = providers ?? [];
    this.#sharedRateLimiter = sharedRateLimiter ?? RateLimiter.unlimited();
    this.#bootstrap = bootstrap;
    this.name =
      this.#providers.length > 0
        ? `FailoverRdapProvider(${this.#providers.map((s) => s.name).join(',')})`
        : 'FailoverRdapProvider(rdap.org+bootstrap)';

    // Build per-server circuit breakers so a degraded server is isolated
    // from healthy ones.
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
   * Create from custom URLs, sharing a single rate limiter across all
   * servers. Custom URLs are treated as universal (authoritative for all
   * TLDs) — the operator takes responsibility for their scope.
   */
  static fromConfig(
    urls: string[],
    rateLimiter?: RateLimiterLike,
    perServerCircuitBreakerPolicy?: Partial<CircuitBreakerPolicy>,
  ): FailoverRdapProvider {
    const providers = urls.map((url, i) => {
      const name = `rdap-server-${i + 1}`;
      return new PublicRdapProvider(
        url,
        name,
        rateLimiter ?? RateLimiter.unlimited(),
        DEFAULT_RDAP_TIMEOUT_MS,
      );
    });
    return new FailoverRdapProvider(providers, rateLimiter, perServerCircuitBreakerPolicy);
  }

  /**
   * Create with the rdap.org universal fallback plus, when a bootstrap is
   * provided, per-TLD authoritative servers resolved from the IANA RDAP
   * bootstrap registry. All servers share one rate limiter so the RDAP
   * ecosystem as a whole is rate-limited, not individual endpoints.
   */
  static withDefaults(
    rateLimiter?: RateLimiterLike,
    perServerCircuitBreakerPolicy?: Partial<CircuitBreakerPolicy>,
    bootstrap?: IanaRdapBootstrap,
  ): FailoverRdapProvider {
    const limiter = rateLimiter ?? RateLimiter.unlimited();
    const universal = new PublicRdapProvider(
      RDAP_ORG_UNIVERSAL.baseUrl,
      RDAP_ORG_UNIVERSAL.name,
      limiter,
      DEFAULT_RDAP_TIMEOUT_MS,
    );
    return new FailoverRdapProvider([universal], limiter, perServerCircuitBreakerPolicy, bootstrap);
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

    const providers = await this.#providersFor(domain);

    // Use a single AbortController to cancel all in-flight requests
    // once a definitive answer wins (winner aborts the rest).
    const winnerAc = new AbortController();
    const combinedSignal = signal ? AbortSignal.any([signal, winnerAc.signal]) : winnerAc.signal;

    const activeProviders: {
      provider: RdapProvider;
      promise: Promise<{ provider: string; result: RdapResult }>;
    }[] = [];
    const errors: string[] = [];

    for (const provider of providers) {
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
          if (result.status !== DomainStatus.Unknown && !winnerAc.signal.aborted) {
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

    const settled = await Promise.allSettled(activeProviders.map((ap) => ap.promise));
    let unknownResult: RdapResult | undefined;

    for (let i = 0; i < activeProviders.length; i++) {
      const { provider } = activeProviders[i]!;
      const s = settled[i]!;

      if (s.status === 'fulfilled') {
        const { result } = s.value;
        // Definitive answer (Available/Registered) — first one in input
        // order wins. Unknown (out-of-zone, rate-limit, server error)
        // never wins the race — it is remembered as the fallback.
        if (result.status !== DomainStatus.Unknown) {
          this.#intraRunCache.set(domain, {
            result,
            expiresAt: now + FailoverRdapProvider.#INTRARUN_CACHE_TTL_MS,
          });
          return result;
        }
        unknownResult ??= result;
      } else {
        errors.push(
          `${provider.name}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
        );
      }
    }

    // No definitive answer: prefer a degraded Unknown over an error —
    // conservative (never fabricate availability) and informative.
    if (unknownResult !== undefined) {
      this.#intraRunCache.set(domain, {
        result: unknownResult,
        expiresAt: now + FailoverRdapProvider.#INTRARUN_CACHE_TTL_MS,
      });
      return unknownResult;
    }

    throw new ProviderError(
      `All RDAP bootstrap servers failed for ${domain}: [${errors.join('; ')}]`,
      this.name,
    );
  }

  /** Resolve the candidate providers for a domain's TLD (cached per TLD). */
  async #providersFor(domain: string): Promise<RdapProvider[]> {
    if (this.#bootstrap === undefined) return this.#providers;

    const tld = extractTld(domain).replace(/^\./, '');
    const cached = this.#perTldProviders.get(tld);
    if (cached !== undefined) return cached;

    // Fixed providers first (e.g. the rdap.org universal fallback), then
    // the TLD's authoritative servers. Unknown responses never win the
    // race, so the universal fallback cannot mask a definitive answer.
    const seen = new Set(this.#providers.map((p) => p.name));
    const providers = [...this.#providers];
    const servers = await this.#bootstrap.getServers(tld);
    for (const server of servers) {
      if (seen.has(server.name)) continue;
      seen.add(server.name);
      providers.push(
        new PublicRdapProvider(
          server.baseUrl,
          server.name,
          this.#sharedRateLimiter,
          DEFAULT_RDAP_TIMEOUT_MS,
          server.tlds.length > 0 ? server.tlds : undefined,
        ),
      );
    }
    this.#perTldProviders.set(tld, providers);
    return providers;
  }
}
