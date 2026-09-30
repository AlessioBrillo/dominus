// SPDX-License-Identifier: AGPL-3.0-only
import type { DnsProvider, DnsCheckResult, DnsCheckOptions } from './dns-provider.js';
import type { RateLimiterLike } from '../rate-limiter.js';
import { DomainStatus } from '../../types/domain-status.js';
import { getLogger } from '../../logger.js';
import { NodeDnsFallback } from './node-dns-fallback.js';
import type { DnsBreakerRegistryLike } from './dns-breaker.js';

const logger = getLogger();

/**
 * FallbackResolver wraps a primary DNS provider (UnboundResolver) and a
 * fallback provider (Node.js DNS, Cloudflare DoH, Google DoH).
 *
 * CRITICAL SAFETY INVARIANT (ADR-0002 conservatism):
 * - The fallback provider is ONLY consulted for verdicts that are NOT "Available"
 * - If the primary provider returns "Available" but is unhealthy/quorum-lost,
 *   we return "Unknown" — NEVER delegate "Available" to a non-DNSSEC-validating fallback
 * - This prevents false-positive Available verdicts when Unbound loses DNSSEC validation
 *
 * The fallback exists to maintain "Registered/Unknown" classification continuity
 * during Unbound outages, not to replace Unbound's DNSSEC-validated Available verdicts.
 */
export interface FallbackResolverOptions {
  /** Primary provider (must be UnboundResolver for DNSSEC validation). */
  primary: DnsProvider & {
    isHealthy?: () => boolean;
    getHealthStatus?: () => {
      healthy: boolean;
      dnssecValid: boolean;
      quorumMet: boolean;
      hosts: Array<{ healthy: boolean; dnssecValid: boolean }>;
    };
  };
  /** Fallback provider for non-Available verdicts when primary is degraded. */
  fallback: DnsProvider;
  /** Enable fallback behavior (default: true). */
  enabled?: boolean;
  /** Only use fallback for non-Available verdicts (default: true, SAFETY GATE). */
  onlyForNonAvailable?: boolean;
  /** Optional rate limiter for fallback queries. */
  fallbackRateLimiter?: RateLimiterLike;
  /** Optional circuit breaker registry shared with primary. */
  breakers?: DnsBreakerRegistryLike;
  /** Callback when fallback becomes active. */
  onFallbackActive?: (active: boolean, reason: string) => void;
}

export class FallbackResolver implements DnsProvider {
  readonly name = 'FallbackResolver';

  readonly #primary: FallbackResolverOptions['primary'];
  readonly #fallback: DnsProvider;
  readonly #enabled: boolean;
  readonly #onlyForNonAvailable: boolean;
  readonly #fallbackRateLimiter: RateLimiterLike | undefined;
  readonly #onFallbackActive: FallbackResolverOptions['onFallbackActive'];
  #fallbackActive = false;
  #lastFallbackReason = '';

  constructor(options: FallbackResolverOptions) {
    this.#primary = options.primary;
    this.#fallback = options.fallback;
    this.#enabled = options.enabled ?? true;
    this.#onlyForNonAvailable = options.onlyForNonAvailable ?? true;
    this.#fallbackRateLimiter = options.fallbackRateLimiter;
    this.#onFallbackActive = options.onFallbackActive;
  }

  /** Check if primary is healthy and DNSSEC-validating with quorum. */
  #isPrimaryHealthy(): boolean {
    if (typeof this.#primary.isHealthy === 'function') {
      return this.#primary.isHealthy();
    }
    if (typeof this.#primary.getHealthStatus === 'function') {
      const status = this.#primary.getHealthStatus();
      return status.healthy && status.dnssecValid && status.quorumMet;
    }
    // Duck-type: assume healthy if no health method (backward compat)
    return true;
  }

  /** Determine if we should use fallback for this result. */
  #shouldUseFallback(result: DnsCheckResult | undefined): boolean {
    if (!this.#enabled) return false;
    if (!this.#isPrimaryHealthy()) {
      // Primary unhealthy — but only fallback for non-Available if gate enabled
      if (this.#onlyForNonAvailable && result?.status === DomainStatus.Available) {
        return false; // SAFETY: never delegate Available to non-DNSSEC fallback
      }
      return true;
    }
    return false;
  }

  /** Activate/deactivate fallback mode with callback. */
  #setFallbackActive(active: boolean, reason: string): void {
    const wasActive = this.#fallbackActive;
    if (wasActive !== active) {
      this.#fallbackActive = active;
      this.#lastFallbackReason = reason;
      logger.warn({ active, reason, primary: this.#primary.name }, 'DNS fallback mode changed');
      this.#onFallbackActive?.(active, reason);
    } else if (active && this.#lastFallbackReason !== reason) {
      this.#lastFallbackReason = reason;
      logger.debug({ reason }, 'DNS fallback reason updated');
    }
    // Always notify on first check (when wasActive is the initial false)
    if (!wasActive && this.#onFallbackActive) {
      this.#onFallbackActive(active, reason);
    }
  }

  /** Create a DnsCheckResult with fallback metadata for Unknown status. */
  #createUnknownResult(domain: string): DnsCheckResult {
    return {
      domain,
      status: DomainStatus.Unknown,
      checkedAt: new Date().toISOString(),
      isParked: false,
      dnssec: 'unchecked',
      dnssecSource: 'unchecked',
      durationMs: 0,
      fromCache: false,
    };
  }

  async checkAvailability(
    domain: string,
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult> {
    // Always try primary first
    let primaryResult: DnsCheckResult | undefined;
    try {
      primaryResult = await this.#primary.checkAvailability(domain, signal, options);
    } catch (err) {
      logger.warn({ err, domain }, 'Primary DNS provider threw, checking fallback eligibility');
    }

    // If primary succeeded and is healthy, return it
    if (primaryResult !== undefined && this.#isPrimaryHealthy()) {
      this.#setFallbackActive(false, 'primary healthy');
      return primaryResult;
    }

    // If fallback is disabled, return primary result even if unhealthy (graceful degradation)
    if (!this.#enabled) {
      // Don't notify callback - fallback is disabled, no mode change to report
      return primaryResult ?? this.#createUnknownResult(domain);
    }

    // Primary failed or unhealthy — check if we should use fallback
    const useFallback = this.#shouldUseFallback(primaryResult);
    if (!useFallback) {
      // Primary unhealthy but result is Available and we block fallback for Available
      this.#setFallbackActive(true, 'primary unhealthy — Available verdict blocked from fallback');
      logger.warn(
        { domain, primaryStatus: primaryResult?.status, primaryDnssec: primaryResult?.dnssec },
        'Primary unhealthy and returned Available — returning Unknown (conservative, no fallback for Available)',
      );
      return this.#createUnknownResult(domain);
    }

    // Use fallback for non-Available or when primary completely failed
    this.#setFallbackActive(
      true,
      primaryResult === undefined ? 'primary failed' : 'primary unhealthy',
    );

    // Acquire fallback rate limiter token if configured
    if (this.#fallbackRateLimiter) {
      try {
        await this.#fallbackRateLimiter.acquire();
      } catch {
        logger.warn({ domain }, 'Fallback rate limit exceeded — returning Unknown');
        return this.#createUnknownResult(domain);
      }
    }

    try {
      const fallbackResult = await this.#fallback.checkAvailability(domain, signal, options);
      // Stamp result with fallback metadata
      return {
        ...fallbackResult,
        dnssec: 'unchecked',
        dnssecSource: 'unchecked',
        fromCache: false,
      };
    } catch (err) {
      logger.error({ err, domain }, 'Fallback DNS provider also failed');
      return this.#createUnknownResult(domain);
    }
  }

  async checkBulk(
    domains: string[],
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult[]> {
    // Try primary bulk first
    let primaryResults: DnsCheckResult[] | undefined;
    try {
      primaryResults = await this.#primary.checkBulk(domains, signal, options);
    } catch (err) {
      logger.warn({ err, count: domains.length }, 'Primary bulk check threw');
    }

    // If primary healthy and returned results, use them
    if (primaryResults !== undefined && this.#isPrimaryHealthy()) {
      this.#setFallbackActive(false, 'primary healthy');
      return primaryResults;
    }

    // Determine which domains need fallback
    const needsFallback: string[] = [];
    const results: (DnsCheckResult | undefined)[] = new Array(domains.length);

    if (primaryResults !== undefined) {
      for (let i = 0; i < domains.length; i++) {
        const domain = domains[i];
        if (!domain) continue;
        const result = primaryResults[i];
        if (this.#shouldUseFallback(result)) {
          needsFallback.push(domain);
        } else {
          // shouldUseFallback returns false when:
          // 1. Primary is healthy (handled above)
          // 2. Fallback is disabled (handled above)
          // 3. Primary is unhealthy but result is Available and we block fallback for Available
          // In case 3, we must NOT keep the primary result - we must block it
          if (!this.#isPrimaryHealthy() && result?.status === DomainStatus.Available) {
            results[i] = this.#createUnknownResult(domain);
          } else {
            results[i] = result;
          }
        }
      }
    } else {
      // Primary completely failed — all domains need fallback (subject to gate)
      for (let i = 0; i < domains.length; i++) {
        const domain = domains[i];
        if (!domain) continue;
        if (this.#shouldUseFallback(undefined)) {
          needsFallback.push(domain);
        } else {
          results[i] = this.#createUnknownResult(domain);
        }
      }
    }

    if (needsFallback.length === 0) {
      return results as DnsCheckResult[];
    }

    this.#setFallbackActive(true, `fallback for ${needsFallback.length}/${domains.length} domains`);

    // Acquire bulk rate limiter tokens
    if (this.#fallbackRateLimiter) {
      try {
        await this.#fallbackRateLimiter.acquire();
      } catch {
        logger.warn({ count: needsFallback.length }, 'Fallback bulk rate limit exceeded');
        for (let i = 0; i < needsFallback.length; i++) {
          const domain = needsFallback[i];
          if (!domain) continue;
          const idx = domains.findIndex((d) => d === domain);
          if (idx !== -1) {
            results[idx] = this.#createUnknownResult(domain);
          }
        }
        return results as DnsCheckResult[];
      }
    }

    // Execute fallback bulk check
    let fallbackResults: DnsCheckResult[];
    try {
      fallbackResults = await this.#fallback.checkBulk(needsFallback, signal, options);
    } catch (err) {
      logger.error({ err, count: needsFallback.length }, 'Fallback bulk check failed');
      fallbackResults = needsFallback.map((domain) => this.#createUnknownResult(domain));
    }

    // Merge results
    for (let i = 0; i < needsFallback.length; i++) {
      const domain = needsFallback[i];
      if (!domain) continue;
      // Find the original index in domains array
      const idx = domains.findIndex((d) => d === domain);
      if (idx === -1) continue;
      const result = fallbackResults[i];
      results[idx] = result
        ? { ...result, dnssec: 'unchecked', dnssecSource: 'unchecked', fromCache: false }
        : this.#createUnknownResult(domain);
    }

    return results as DnsCheckResult[];
  }

  /** Get current fallback status for metrics/health endpoints. */
  getFallbackStatus(): { active: boolean; reason: string; primaryHealthy: boolean } {
    return {
      active: this.#fallbackActive,
      reason: this.#lastFallbackReason,
      primaryHealthy: this.#isPrimaryHealthy(),
    };
  }

  /** Delegate to primary for cache pruning (fallback has no persistent cache). */
  pruneCache(): number {
    if (typeof this.#primary.pruneCache === 'function') {
      return this.#primary.pruneCache();
    }
    return 0;
  }

  /** Delegate to primary for cache clearing. */
  clearCache(): void {
    if (typeof this.#primary.clearCache === 'function') {
      this.#primary.clearCache();
    }
    if (typeof this.#fallback.clearCache === 'function') {
      this.#fallback.clearCache();
    }
  }

  /** Dispose both providers. */
  dispose(): void {
    if (typeof this.#primary.dispose === 'function') {
      this.#primary.dispose();
    }
    if (typeof this.#fallback.dispose === 'function') {
      this.#fallback.dispose();
    }
  }
}

/**
 * Factory function to create the appropriate fallback provider based on config.
 */
export async function createFallbackProvider(
  type: 'node-dns' | 'cloudflare-doh' | 'google-doh',
  options: {
    rateLimiter?: RateLimiterLike;
    breakers?: DnsBreakerRegistryLike;
    lookupTimeoutMs?: number;
    cacheTtlMs?: number;
    maxSize?: number;
  } = {},
): Promise<DnsProvider> {
  const baseOptions = {
    lookupTimeoutMs: options.lookupTimeoutMs ?? 1500,
    cacheTtlMs: options.cacheTtlMs ?? 300_000,
    maxSize: options.maxSize ?? 10000,
    ...(options.rateLimiter !== undefined ? { rateLimiter: options.rateLimiter } : {}),
  };

  switch (type) {
    case 'node-dns':
      return new NodeDnsFallback(baseOptions);
    case 'cloudflare-doh':
      // TODO: Implement Cloudflare DoH provider (ADR-0069/0065)
      // For now, fall back to node-dns with warning
      logger.warn('Cloudflare DoH fallback not yet implemented, using node-dns');
      return new NodeDnsFallback(baseOptions);
    case 'google-doh':
      // TODO: Implement Google DoH provider (ADR-0069/0065)
      logger.warn('Google DoH fallback not yet implemented, using node-dns');
      return new NodeDnsFallback(baseOptions);
    default:
      throw new Error(`Unknown fallback provider type: ${type}`);
  }
}
