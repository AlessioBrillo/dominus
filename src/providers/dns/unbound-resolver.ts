// SPDX-License-Identifier: AGPL-3.0-only
import { Resolver } from 'node:dns';
import { LRUCache } from 'lru-cache';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider, DnsCheckOptions } from './dns-provider.js';
import { DomainStatus } from '../../types/domain-status.js';
import { withRetry } from '../retry-utils.js';
import type { RetryPolicy } from '../retry-policy.js';
import type { ProviderCacheRepository } from '../../db/repositories/provider-cache-repository.js';
import { getLogger } from '../../logger.js';
import type { RateLimiterLike } from '../rate-limiter.js';
import type { DnsBreakerRegistryLike } from './dns-breaker.js';

const logger = getLogger();

/**
 * STALE_UNKNOWN_WINDOW_MS: Persistent-cache Unknown rows older than this are
 * treated as misses and re-checked live. Keeps transient failures from being
 * frozen for the full persistent TTL (7 days by default).
 */
const STALE_UNKNOWN_WINDOW_MS = 15 * 60_000;

/**
 * STALE_AVAILABLE_DEFAULT_MS: Persistent-cache Available rows older than this
 * are re-checked live. Availability is the risky verdict (a false positive
 * produces a wasted buy recommendation), so it must not be frozen for the full
 * persistent TTL — unlike Registered, which is conservative. Default 24h
 * (ADR-0002 conservatism, mirrors the RDAP 404 semantics of ADR-0035).
 */
const STALE_AVAILABLE_DEFAULT_MS = 24 * 60 * 60_000;

/** Default cooldown for unhealthy hosts before retry (ms). */
const DEFAULT_UNHEALTHY_COOLDOWN_MS = 30_000;

/** Maximum consecutive failures before marking host unhealthy. */
const MAX_CONSECUTIVE_FAILURES = 3;

type DnsRecordType = 'A' | 'AAAA' | 'NS' | 'SOA';

/** Well-known DNSSEC test zone used as a positive control: proves the test
 *  zone itself is reachable, so a subsequent SERVFAIL on the sibling "sigfail"
 *  name can only mean the resolver rejected a bad signature — not that the
 *  zone is simply unreachable. Exported for test use only. */
export const DNSSEC_POSITIVE_CONTROL = 'sigok.verteiltesysteme.net';
/** Deliberately misconfigured record in the same zone as the positive
 *  control above. A validating resolver MUST reject it with SERVFAIL.
 *  Exported for test use only. */
export const DNSSEC_NEGATIVE_CONTROL = 'sigfail.verteiltesysteme.net';
/** Fallback negative control, used only when the primary zone is unreachable
 *  (retired test domain / egress filtering). Exported for test use only. */
export const DNSSEC_NEGATIVE_CONTROL_FALLBACK = 'dnssec-failed.org';

interface HostHealth {
  resolver: Resolver;
  consecutiveFailures: number;
  lastFailureAt: number;
  lastCheckAt: number;
  dnssecValid: boolean;
  healthy: boolean;
}

/** Per-host DNSSEC validation result for metrics/observability. */
export interface UnboundHostDnssecResult {
  host: string;
  dnssecValid: boolean;
  healthy: boolean;
  consecutiveFailures: number;
  lastCheckAt: number;
}

/**
 * UnboundResolver provides DNS resolution via a local Unbound recursive
 * resolver (typically running as a sidecar container or on the host). It uses
 * Node's native `dns.Resolver` pointed at the Unbound instance(s).
 *
 * The app-to-Unbound hop is plain DNS over the container/host network —
 * Node's `dns.Resolver` has no DoT/DoH capability. The encrypted hop that
 * matters is Unbound-to-upstream (`forward-tls-upstream: yes` in
 * `deploy/unbound/unbound.conf`). DNSSEC validation is performed by Unbound
 * itself and is proven, not assumed: `healthCheck()` runs a negative-control
 * probe (see DNSSEC_NEGATIVE_CONTROL below) once at boot, since `node:dns`
 * cannot read the AD flag on a per-query basis to verify it directly.
 *
 * This is the SINGLE SOURCE OF TRUTH for DNS in the hardened architecture
 * (ADR-0072). All multi-leg consensus complexity (DoH/DoT/tertiary) is
 * deprecated in favor of one properly configured Unbound cluster.
 *
 * Multi-host support (ADR-0072 completion):
 * - Each host gets its own Resolver instance for isolation
 * - Round-robin selection with health awareness
 * - Per-host DNSSEC validation via negative-control probe
 * - Automatic failover to fallback provider when all hosts unhealthy
 * - Automatic recovery with accelerated revalidation in fallback mode
 */
export interface UnboundResolverOptions {
  /** Unbound host(s) — comma-separated, e.g. '127.0.0.1,::1' or 'unbound:5300'. */
  unboundHosts: string[];
  /** Per-query timeout in milliseconds (default: 1500). */
  lookupTimeoutMs?: number;
  /** In-memory cache TTL in milliseconds (default: 300000 = 5min). */
  cacheTtlMs?: number;
  /** Maximum in-memory cache entries (default: 10000, 0 = disabled). */
  maxSize?: number;
  /** Bulk check concurrency (default: 200). */
  bulkConcurrency?: number;
  /** Optional rate limiter for outbound queries. */
  rateLimiter?: RateLimiterLike;
  /** Optional retry policy. */
  retryPolicy?: Partial<RetryPolicy>;
  /** Optional persistent cache repository. */
  persistentCache?: ProviderCacheRepository | undefined;
  /** Persistent cache TTL in hours (default: 168 = 7 days). */
  persistentCacheTtlHours?: number;
  /** Persistent-cache Available stale window in ms (default: 24h). */
  persistentAvailableStaleMs?: number;
  /** Optional shared circuit breaker registry. */
  breakers?: DnsBreakerRegistryLike | undefined;
  /** Enable DNSSEC validation (default: true). */
  dnssecValidationEnabled?: boolean | undefined;
  /**
   * DNSSEC validation mode for available verdicts (default: 'strict').
   * - 'strict': Only 'valid' DNSSEC passes (conservative, ADR-0002).
   * - 'permissive': 'valid' OR 'insecure' (unsigned zones) pass.
   * - 'disabled': DNSSEC not required for available verdicts.
   */
  dnssecMode?: 'strict' | 'permissive' | 'disabled';
  /** Enable parking page detection (default: false). */
  parkingEnabled?: boolean | undefined;
  /** Optional callback for recording resolution metrics (ADR-0072). */
  onResolution?:
    | ((stats: {
        durationMs: number;
        status: 'registered' | 'available' | 'unknown';
        dnssec: 'valid' | 'unchecked' | 'bogus';
        fromCache: boolean;
        host?: string;
      }) => void)
    | undefined;
  /** Optional callback invoked when DNSSEC validation state changes.
   *  Receives the new validation state (true = validating, false = lost).
   *  Used to emit Prometheus metrics for alerting. */
  onDnssecValidationChange?: ((validating: boolean) => void) | undefined;
  /** Optional callback invoked when per-host DNSSEC validation state changes.
   *  Receives host and new validation state. Used for per-host metrics. */
  onHostDnssecValidationChange?: ((host: string, validating: boolean) => void) | undefined;
  /** Interval in milliseconds for periodic DNSSEC revalidation (default: 600000 = 10 min).
   *  Set to 0 to disable periodic revalidation. */
  dnssecRevalidationIntervalMs?: number;
  /** Interval in milliseconds for periodic DNSSEC revalidation while in fallback mode (default: 30000 = 30s).
   *  Accelerated to detect recovery faster. */
  dnssecFallbackRevalidationIntervalMs?: number;
  /** Maximum number of unhealthy hosts before activating fallback (default: 1).
   *  When >= this many hosts are unhealthy, fallback is activated. */
  maxUnhealthyBeforeFallback?: number;
  /** Cooldown in ms before retrying an unhealthy host (default: 30000). */
  unhealthyCooldownMs?: number;
  /** Optional fallback DNS provider. When Unbound becomes unhealthy or loses
   *  DNSSEC validation, the resolver delegates to this provider.
   *  Used for graceful degradation in community edition without Docker. */
  fallbackProvider?: DnsProvider | undefined;
}

export class UnboundResolver implements DnsProvider {
  readonly name = 'UnboundResolver';

  readonly #unboundHosts: string[];
  readonly #lookupTimeoutMs: number;
  readonly #cacheTtlMs: number;
  readonly #maxSize: number;
  readonly #bulkConcurrency: number;
  readonly #rateLimiter: RateLimiterLike | undefined;
  readonly #retryPolicy: Partial<RetryPolicy> | undefined;
  readonly #persistentCache: ProviderCacheRepository | undefined;
  readonly #persistentCacheTtlHours: number;
  readonly #persistentAvailableStaleMs: number;
  readonly #breakers: DnsBreakerRegistryLike | undefined;
  readonly #cacheDisabled: boolean;
  readonly #cache: LRUCache<string, DnsCheckResult>;
  readonly #pending: Map<string, Promise<DnsCheckResult>> = new Map();
  readonly #hostHealth: Map<string, HostHealth> = new Map();
  #roundRobinIndex = 0;
  readonly #onResolution: UnboundResolverOptions['onResolution'];
  readonly #onDnssecValidationChange: UnboundResolverOptions['onDnssecValidationChange'];
  readonly #onHostDnssecValidationChange: UnboundResolverOptions['onHostDnssecValidationChange'];
  readonly #dnssecRevalidationIntervalMs: number;
  readonly #dnssecFallbackRevalidationIntervalMs: number;
  readonly #dnssecValidationEnabled: boolean;
  readonly #dnssecMode: 'strict' | 'permissive' | 'disabled';
  /** Optional fallback DNS provider for graceful degradation. */
  #fallbackProvider: DnsProvider | undefined;
  /** Whether we are currently using the fallback provider. */
  #usingFallback = false;
  /** Global DNSSEC validation state (true if ANY host validates). */
  #dnssecValidating = false;
  #revalidationTimer: ReturnType<typeof setInterval> | undefined;
  #fallbackRevalidationTimer: ReturnType<typeof setInterval> | undefined;
  readonly #maxUnhealthyBeforeFallback: number;
  readonly #unhealthyCooldownMs: number;

  constructor(options: UnboundResolverOptions) {
    if (!options.unboundHosts || options.unboundHosts.length === 0) {
      throw new Error('UnboundResolver requires at least one unbound host');
    }
    this.#unboundHosts = options.unboundHosts;
    this.#lookupTimeoutMs = options.lookupTimeoutMs ?? 1500;
    this.#cacheTtlMs = options.cacheTtlMs ?? 300_000;
    this.#maxSize = options.maxSize ?? 10000;
    this.#bulkConcurrency = options.bulkConcurrency ?? 200;
    this.#rateLimiter = options.rateLimiter;
    this.#retryPolicy = options.retryPolicy;
    this.#persistentCache = options.persistentCache;
    this.#persistentCacheTtlHours = options.persistentCacheTtlHours ?? 168;
    this.#persistentAvailableStaleMs =
      options.persistentAvailableStaleMs ?? STALE_AVAILABLE_DEFAULT_MS;
    this.#breakers = options.breakers;
    this.#dnssecValidationEnabled = options.dnssecValidationEnabled ?? true;
    this.#dnssecMode = options.dnssecMode ?? 'strict';
    this.#onResolution = options.onResolution;
    this.#onDnssecValidationChange = options.onDnssecValidationChange;
    this.#onHostDnssecValidationChange = options.onHostDnssecValidationChange;
    this.#dnssecRevalidationIntervalMs = options.dnssecRevalidationIntervalMs ?? 600_000;
    this.#dnssecFallbackRevalidationIntervalMs =
      options.dnssecFallbackRevalidationIntervalMs ?? 30_000;
    this.#fallbackProvider = options.fallbackProvider;
    this.#usingFallback = false;
    this.#maxUnhealthyBeforeFallback = options.maxUnhealthyBeforeFallback ?? 1;
    this.#unhealthyCooldownMs = options.unhealthyCooldownMs ?? DEFAULT_UNHEALTHY_COOLDOWN_MS;

    // Create dedicated resolver per host for isolation
    for (const host of this.#unboundHosts) {
      const resolver = new Resolver();
      resolver.setServers([host]);
      this.#hostHealth.set(host, {
        resolver,
        consecutiveFailures: 0,
        lastFailureAt: 0,
        lastCheckAt: 0,
        dnssecValid: false,
        healthy: true, // Assume healthy until proven otherwise
      });
    }

    this.#cacheDisabled = this.#maxSize <= 0;
    const cacheOptions: LRUCache.Options<string, DnsCheckResult, unknown> = {
      max: this.#cacheDisabled ? 1 : this.#maxSize,
      noUpdateTTL: false,
      allowStale: false,
      perf: { now: (): number => Date.now() },
    };
    if (this.#cacheTtlMs > 0) cacheOptions.ttl = this.#cacheTtlMs;
    this.#cache = new LRUCache<string, DnsCheckResult>(cacheOptions);
  }

  /** Get all configured hosts. */
  getHosts(): string[] {
    return [...this.#unboundHosts];
  }

  /** Get per-host health status for observability. */
  getHostHealth(): UnboundHostDnssecResult[] {
    const results: UnboundHostDnssecResult[] = [];
    for (const [host, health] of this.#hostHealth) {
      results.push({
        host,
        dnssecValid: health.dnssecValid,
        healthy: health.healthy,
        consecutiveFailures: health.consecutiveFailures,
        lastCheckAt: health.lastCheckAt,
      });
    }
    return results;
  }

  /** Get count of healthy hosts. */
  getHealthyHostCount(): number {
    let count = 0;
    for (const health of this.#hostHealth.values()) {
      if (health.healthy) count++;
    }
    return count;
  }

  /** Set a fallback DNS provider at runtime. */
  setFallback(provider: DnsProvider): void {
    this.#fallbackProvider = provider;
  }

  /** Check if currently using the fallback provider. */
  isUsingFallback(): boolean {
    return this.#usingFallback;
  }

  /** Activate fallback mode (internal). */
  #activateFallback(reason: string): void {
    if (!this.#usingFallback) {
      this.#usingFallback = true;
      logger.warn(
        {
          fallback: this.#fallbackProvider?.name,
          reason,
          healthyHosts: this.getHealthyHostCount(),
        },
        'Unbound: activating fallback provider',
      );
      // Clear memory cache so subsequent lookups go to fallback
      if (!this.#cacheDisabled) this.#cache.clear();
      // Start accelerated revalidation timer
      this.#startFallbackRevalidation();
    }
  }

  /** Deactivate fallback mode (internal). */
  #deactivateFallback(reason: string): void {
    if (this.#usingFallback) {
      this.#usingFallback = false;
      logger.info(
        { reason, healthyHosts: this.getHealthyHostCount() },
        'Unbound: deactivating fallback provider, resuming primary',
      );
      // Clear memory cache so subsequent lookups go to primary
      if (!this.#cacheDisabled) this.#cache.clear();
      // Stop accelerated revalidation timer
      this.#stopFallbackRevalidation();
      // Resume normal periodic revalidation
      this.startPeriodicRevalidation();
    }
  }

  /** Start accelerated revalidation while in fallback mode. */
  #startFallbackRevalidation(): void {
    if (this.#fallbackRevalidationTimer !== undefined) return;
    if (this.#dnssecFallbackRevalidationIntervalMs <= 0) return;

    this.#fallbackRevalidationTimer = setInterval(async () => {
      const result = await this.revalidateDnssecValidation();
      // Check if ANY host is now healthy + DNSSEC valid
      const anyHealthyValidating = this.getHealthyHostCount() > 0 && result.dnssecValid;
      if (this.#onDnssecValidationChange && anyHealthyValidating !== this.#dnssecValidating) {
        this.#onDnssecValidationChange(anyHealthyValidating);
      }
      // Auto-recover if we have healthy hosts with DNSSEC validation
      if (anyHealthyValidating && this.#usingFallback) {
        this.#deactivateFallback(
          'fallback revalidation: DNSSEC validation regained on healthy host',
        );
      }
    }, this.#dnssecFallbackRevalidationIntervalMs).unref();
  }

  /** Stop accelerated revalidation timer. */
  #stopFallbackRevalidation(): void {
    if (this.#fallbackRevalidationTimer !== undefined) {
      clearInterval(this.#fallbackRevalidationTimer);
      this.#fallbackRevalidationTimer = undefined;
    }
  }

  /** Start periodic DNSSEC validation revalidation (ADR-0072).
   *  Runs revalidateDnssecValidation() at the configured interval.
   *  Emits metrics via onDnssecValidationChange callback when state changes. */
  startPeriodicRevalidation(): void {
    if (this.#revalidationTimer !== undefined) return; // already running
    if (this.#dnssecRevalidationIntervalMs <= 0) return; // disabled
    if (this.#usingFallback) return; // fallback mode uses accelerated timer

    this.#revalidationTimer = setInterval(async () => {
      const result = await this.revalidateDnssecValidation();
      if (this.#onDnssecValidationChange && result.dnssecValid !== this.#dnssecValidating) {
        this.#onDnssecValidationChange(result.dnssecValid);
      }
    }, this.#dnssecRevalidationIntervalMs).unref();
  }

  /** Stop periodic DNSSEC validation revalidation. */
  stopPeriodicRevalidation(): void {
    if (this.#revalidationTimer !== undefined) {
      clearInterval(this.#revalidationTimer);
      this.#revalidationTimer = undefined;
    }
    this.#stopFallbackRevalidation();
  }

  /** Close the resolver and clear pending lookups. */
  dispose(): void {
    this.stopPeriodicRevalidation();
    // Clear pending first so in-flight lookups fail fast
    this.#pending.clear();
    for (const health of this.#hostHealth.values()) {
      health.resolver.cancel();
    }
    // Don't clear hostHealth - in-flight lookups may still need it
    // The resolvers are cancelled, so new lookups will fail fast
    // Dispose fallback provider if it exists
    if (
      this.#fallbackProvider !== undefined &&
      typeof this.#fallbackProvider.dispose === 'function'
    ) {
      const result = this.#fallbackProvider.dispose();
      if (result !== undefined) {
        Promise.resolve(result).catch(() => {});
      }
    }
  }

  pruneCache(): number {
    if (this.#cacheDisabled) return 0;
    const before = this.#cache.size;
    this.#cache.purgeStale();
    const after = this.#cache.size;
    return before - after;
  }

  clearCache(): void {
    if (!this.#cacheDisabled) this.#cache.clear();
  }

  /** Current circuit state counts across the shared registry (metrics/tests),
   *  or undefined when no breaker registry is wired. */
  breakerSnapshot(): { open: number; closed: number; halfOpen: number; total: number } | undefined {
    if (this.#breakers === undefined) return undefined;
    const registry = this.#breakers as {
      snapshot?: () => { open: number; closed: number; halfOpen: number; total: number };
    };
    return registry.snapshot?.();
  }

  /**
   * Health check for the Unbound resolver. First confirms basic reachability
   * (A record for cloudflare.com), then proves DNSSEC validation is actually
   * active via a negative-control probe: `node:dns` cannot read the AD flag,
   * so "the resolver returns an answer" proves nothing about validation — a
   * misconfigured resolver (`val-permissive-mode: yes`) resolves everything.
   * Instead we query a name with a deliberately bad signature
   * (DNSSEC_NEGATIVE_CONTROL) and require an explicit SERVFAIL; a sibling
   * name in the same zone (DNSSEC_POSITIVE_CONTROL) proves the zone itself
   * is reachable, so the SERVFAIL can't be mistaken for a network failure.
   * The result is cached on the instance and stamped on every subsequent
   * per-domain lookup (see #dnssecValidating).
   *
   * If health check fails and a fallback provider is configured, activates
   * fallback mode for subsequent queries.
   *
   * Runs per-host probes and aggregates results.
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    dnssecValid: boolean;
    details: string;
    hosts: UnboundHostDnssecResult[];
  }> {
    const testDomain = 'cloudflare.com';
    const timeoutMs = 3000;

    const hostResults: UnboundHostDnssecResult[] = [];
    let anyHealthy = false;
    let anyDnssecValid = false;

    for (const host of this.#unboundHosts) {
      const health = this.#hostHealth.get(host)!;
      try {
        const aResult = await Promise.race([
          this.#resolveWithTimeout(host, testDomain, 'A', timeoutMs),
          new Promise<boolean>((_, reject) =>
            setTimeout(() => reject(new Error('health check timeout')), timeoutMs),
          ),
        ]);
        if (!aResult) {
          this.#markHostUnhealthy(host, 'A record resolution failed');
          hostResults.push({
            host,
            dnssecValid: false,
            healthy: false,
            consecutiveFailures: health.consecutiveFailures,
            lastCheckAt: Date.now(),
          });
          continue;
        }

        const dnssecValid = await this.#probeDnssecValidationOnHost(host, timeoutMs);
        health.dnssecValid = dnssecValid;
        health.lastCheckAt = Date.now();
        health.healthy = true;
        health.consecutiveFailures = 0;

        if (dnssecValid) {
          anyDnssecValid = true;
        }
        anyHealthy = true;

        hostResults.push({
          host,
          dnssecValid,
          healthy: true,
          consecutiveFailures: 0,
          lastCheckAt: health.lastCheckAt,
        });

        if (this.#onHostDnssecValidationChange) {
          this.#onHostDnssecValidationChange(host, dnssecValid);
        }
      } catch (err) {
        this.#markHostUnhealthy(host, String(err));
        hostResults.push({
          host,
          dnssecValid: false,
          healthy: false,
          consecutiveFailures: health.consecutiveFailures,
          lastCheckAt: Date.now(),
        });
      }
    }

    this.#dnssecValidating = anyDnssecValid;

    if (!anyHealthy) {
      this.#activateFallback('health check: no healthy Unbound hosts');
      return {
        healthy: false,
        dnssecValid: false,
        details: 'No healthy Unbound hosts',
        hosts: hostResults,
      };
    }

    if (!anyDnssecValid) {
      this.#activateFallback('health check: DNSSEC validation not confirmed on any host');
    } else {
      this.#deactivateFallback('health check: DNSSEC validation confirmed');
    }

    return {
      healthy: true,
      dnssecValid: anyDnssecValid,
      details: anyDnssecValid
        ? 'DNSSEC validation confirmed on at least one host (negative-control signature rejected with SERVFAIL)'
        : 'DNSSEC validation NOT confirmed — all healthy hosts accepted a bad signature, or negative-control probe was inconclusive',
      hosts: hostResults,
    };
  }

  /** Periodic DNSSEC validation revalidation (ADR-0072 hardening).
   *  Runs the same negative-control probe as healthCheck() to detect
   *  runtime reconfiguration (e.g., val-permissive-mode: yes via rndc).
   *  Updates internal #dnssecValidating state and returns the new status.
   *  Call this periodically (e.g., every 10 minutes via scheduler) or
   *  on-demand after suspected resolver reconfiguration.
   *
   * If revalidation fails or validation is lost, and a fallback provider is
   * configured, activates fallback mode for subsequent queries.
   */
  async revalidateDnssecValidation(): Promise<{
    healthy: boolean;
    dnssecValid: boolean;
    details: string;
    hosts: UnboundHostDnssecResult[];
  }> {
    const testDomain = 'cloudflare.com';
    const timeoutMs = 3000;

    const hostResults: UnboundHostDnssecResult[] = [];
    let anyHealthy = false;
    let anyDnssecValid = false;

    for (const host of this.#unboundHosts) {
      const health = this.#hostHealth.get(host)!;
      // Skip hosts that are in cooldown
      if (!health.healthy && Date.now() - health.lastFailureAt < this.#unhealthyCooldownMs) {
        hostResults.push({
          host,
          dnssecValid: health.dnssecValid,
          healthy: false,
          consecutiveFailures: health.consecutiveFailures,
          lastCheckAt: health.lastCheckAt,
        });
        continue;
      }

      try {
        const aResult = await Promise.race([
          this.#resolveWithTimeout(host, testDomain, 'A', timeoutMs),
          new Promise<boolean>((_, reject) =>
            setTimeout(() => reject(new Error('revalidation timeout')), timeoutMs),
          ),
        ]);
        if (!aResult) {
          this.#markHostUnhealthy(host, 'A record resolution failed');
          hostResults.push({
            host,
            dnssecValid: false,
            healthy: false,
            consecutiveFailures: health.consecutiveFailures,
            lastCheckAt: Date.now(),
          });
          continue;
        }

        const dnssecValid = await this.#probeDnssecValidationOnHost(host, timeoutMs);
        const previousDnssecValid = health.dnssecValid;
        health.dnssecValid = dnssecValid;
        health.lastCheckAt = Date.now();
        health.healthy = true;
        health.consecutiveFailures = 0;

        if (dnssecValid) {
          anyDnssecValid = true;
        }
        anyHealthy = true;

        hostResults.push({
          host,
          dnssecValid,
          healthy: true,
          consecutiveFailures: 0,
          lastCheckAt: health.lastCheckAt,
        });

        if (this.#onHostDnssecValidationChange && dnssecValid !== previousDnssecValid) {
          this.#onHostDnssecValidationChange(host, dnssecValid);
        }
      } catch (err) {
        this.#markHostUnhealthy(host, String(err));
        hostResults.push({
          host,
          dnssecValid: health.dnssecValid,
          healthy: false,
          consecutiveFailures: health.consecutiveFailures,
          lastCheckAt: Date.now(),
        });
      }
    }

    const previousValidating = this.#dnssecValidating;
    const validationChanged = previousValidating !== anyDnssecValid;
    this.#dnssecValidating = anyDnssecValid;

    if (!anyHealthy) {
      this.#activateFallback('revalidation: no healthy Unbound hosts');
      const result = {
        healthy: false,
        dnssecValid: false,
        details: 'No healthy Unbound hosts during revalidation',
        hosts: hostResults,
      };
      logger.warn({ details: result.details }, 'Unbound: DNSSEC revalidation failed');
      return result;
    }

    if (!anyDnssecValid) {
      this.#activateFallback('revalidation: DNSSEC validation lost on all hosts');
    } else if (previousValidating === false && anyDnssecValid === true) {
      this.#deactivateFallback('revalidation: DNSSEC validation regained');
    }

    // Invalidate memory cache when DNSSEC validation state changes,
    // so subsequent lookups get the correct dnssec stamp.
    if (validationChanged && !this.#cacheDisabled) {
      this.#cache.clear();
      logger.info(
        { previousValidating, dnssecValid: anyDnssecValid },
        'Unbound: memory cache invalidated due to DNSSEC validation state change',
      );
    }

    const result = {
      healthy: true,
      dnssecValid: anyDnssecValid,
      details: anyDnssecValid
        ? 'DNSSEC validation confirmed (negative-control signature rejected with SERVFAIL)'
        : 'DNSSEC validation LOST — all healthy hosts accepted a bad signature (possible val-permissive-mode reconfiguration)',
      hosts: hostResults,
    };

    if (previousValidating && !anyDnssecValid) {
      logger.error(
        { previousValidating, dnssecValid: anyDnssecValid },
        'Unbound: DNSSEC validation LOST during revalidation',
      );
    } else if (!previousValidating && anyDnssecValid) {
      logger.info(
        { previousValidating, dnssecValid: anyDnssecValid },
        'Unbound: DNSSEC validation REGAINED during revalidation',
      );
    } else {
      logger.debug({ dnssecValid: anyDnssecValid }, 'Unbound: DNSSEC revalidation completed');
    }

    return result;
  }

  /** Quick runtime health check — returns true if ANY host is healthy
   *  and DNSSEC validation is currently proven active. This is a lightweight
   *  check (no full negative-control probe) suitable for frequent polling
   *  by the soft-fail fallback logic in the provider factory.
   */
  isHealthy(): boolean {
    // A resolver is "healthy" if it has proven DNSSEC validation at some point
    // and the last revalidation didn't fail catastrophically.
    // We don't re-run the probe here — just report the last known state.
    return this.#dnssecValidating && this.getHealthyHostCount() > 0;
  }

  /** Detailed health status for diagnostics and alerting.
   *  Returns the last known health state without triggering a new probe.
   *  For a fresh probe, call revalidateDnssecValidation() instead.
   */
  getHealthStatus(): {
    healthy: boolean;
    dnssecValid: boolean;
    details: string;
    hosts: UnboundHostDnssecResult[];
  } {
    return {
      healthy: this.#dnssecValidating && this.getHealthyHostCount() > 0,
      dnssecValid: this.#dnssecValidating,
      details: this.#dnssecValidating
        ? 'DNSSEC validation active (last revalidation passed)'
        : 'DNSSEC validation NOT active — resolver may be misconfigured or unreachable',
      hosts: this.getHostHealth(),
    };
  }

  /** Select the next healthy host using round-robin.
   *  Returns the host string, or undefined if no healthy hosts available. */
  #selectHealthyHost(): string | undefined {
    const hosts = this.#unboundHosts;
    if (hosts.length === 0) return undefined;
    // If hostHealth is empty (e.g., after dispose), no hosts available
    if (this.#hostHealth.size === 0) return undefined;

    // Fast path: if only one host, return it if healthy
    if (hosts.length === 1) {
      const host = hosts[0]!;
      const health = this.#hostHealth.get(host)!;
      if (health.healthy) return host;
      // Check cooldown
      if (Date.now() - health.lastFailureAt >= this.#unhealthyCooldownMs) {
        // Try to revive it
        health.healthy = true;
        health.consecutiveFailures = 0;
        return host;
      }
      return undefined;
    }

    // Multi-host: round-robin with health check
    let attempts = 0;
    while (attempts < hosts.length) {
      const host = hosts[this.#roundRobinIndex]!;
      this.#roundRobinIndex = (this.#roundRobinIndex + 1) % hosts.length;
      attempts++;

      const health = this.#hostHealth.get(host);
      if (!health) continue; // Host was removed (e.g., after dispose)
      if (health.healthy) return host;

      // Check if cooldown expired — revive host
      if (Date.now() - health.lastFailureAt >= this.#unhealthyCooldownMs) {
        health.healthy = true;
        health.consecutiveFailures = 0;
        logger.info({ host }, 'Unbound: host revived after cooldown');
        return host;
      }
    }

    return undefined; // No healthy hosts
  }

  /** Mark a host as unhealthy after a failure. */
  #markHostUnhealthy(host: string, reason: string): void {
    const health = this.#hostHealth.get(host);
    if (!health) return;

    health.consecutiveFailures++;
    health.lastFailureAt = Date.now();

    if (health.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      health.healthy = false;
      logger.warn(
        { host, consecutiveFailures: health.consecutiveFailures, reason },
        'Unbound: host marked unhealthy',
      );
    }

    // Check if we should activate fallback
    const unhealthyCount = this.getUnhealthyHostCount();
    if (unhealthyCount >= this.#maxUnhealthyBeforeFallback && !this.#usingFallback) {
      this.#activateFallback(
        `${unhealthyCount}/${this.#unboundHosts.length} hosts unhealthy: ${reason}`,
      );
    }
  }

  /** Get count of unhealthy hosts. */
  getUnhealthyHostCount(): number {
    let count = 0;
    for (const health of this.#hostHealth.values()) {
      if (!health.healthy) count++;
    }
    return count;
  }

  /** Record a successful query on a host. */
  #recordHostSuccess(host: string): void {
    const health = this.#hostHealth.get(host);
    if (health) {
      health.consecutiveFailures = 0;
      health.healthy = true;
    }
  }

  /** Runs the negative-control probe on a specific host. Returns
   *  true only on an explicit, proven rejection — inconclusive results
   *  (timeouts, unreachable test zone) fail closed to false, never true. */
  async #probeDnssecValidationOnHost(host: string, timeoutMs: number): Promise<boolean> {
    const zoneReachable = await this.#resolvesOkOnHost(host, DNSSEC_POSITIVE_CONTROL, timeoutMs);
    if (zoneReachable) {
      const rejected = await this.#probeRejectsBogusSignatureOnHost(
        host,
        DNSSEC_NEGATIVE_CONTROL,
        timeoutMs,
      );
      if (rejected !== undefined) return rejected;
    }
    // Primary zone unreachable or inconclusive — try the fallback negative
    // control. Still fail closed (undefined -> false) if that's inconclusive too.
    const rejected = await this.#probeRejectsBogusSignatureOnHost(
      host,
      DNSSEC_NEGATIVE_CONTROL_FALLBACK,
      timeoutMs,
    );
    return rejected ?? false;
  }

  async #resolvesOkOnHost(host: string, domain: string, timeoutMs: number): Promise<boolean> {
    try {
      return await this.#resolveWithTimeout(host, domain, 'A', timeoutMs);
    } catch {
      return false;
    }
  }

  /** Returns true if the resolver proved it rejects a bad DNSSEC signature
   *  (SERVFAIL), false if it proved it does NOT (the name resolved despite
   *  the bad signature — the val-permissive-mode bypass this check exists to
   *  catch), or undefined if inconclusive after retries (any other error —
   *  never treated as proof either way). */
  async #probeRejectsBogusSignatureOnHost(
    host: string,
    domain: string,
    timeoutMs: number,
  ): Promise<boolean | undefined> {
    const attempts = 2;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.#resolveWithTimeout(host, domain, 'A', timeoutMs);
        return false; // resolved despite the bad signature -> validation bypassed
      } catch (err) {
        if ((err as { code?: string }).code === 'ESERVFAIL') return true; // proven rejection
        // Any other error (ENOTFOUND/ETIMEOUT/...) is inconclusive — retry once
        // before giving up, so a single transient blip can't block boot.
      }
    }
    return undefined;
  }

  async checkAvailability(
    domain: string,
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // If in fallback mode and fallback provider exists, delegate to it
    if (this.#usingFallback && this.#fallbackProvider !== undefined) {
      return this.#fallbackProvider.checkAvailability(domain, signal, options);
    }

    const startTime = Date.now();

    // 1. Memory cache (fastest) — used for within-run dedup even with forceRecheck
    if (!this.#cacheDisabled) {
      const memCached = this.#cache.get(domain);
      if (memCached !== undefined) {
        const durationMs = Date.now() - startTime;
        this.#recordMetrics(memCached, durationMs, true, undefined);
        return { ...memCached, durationMs, fromCache: true };
      }
    }

    // 2. Persistent cache (DB-backed, survives restarts)
    //    Skip when forceRecheck is true: closeout domains may have changed
    //    status since the last lookup (e.g. newly expired).
    if (!options?.forceRecheck && this.#persistentCache !== undefined) {
      const raw = await this.#persistentCache.get(domain, this.name).catch(() => null);
      if (raw !== null) {
        try {
          const parsed: DnsCheckResult = JSON.parse(raw) as DnsCheckResult;
          if (parsed.status !== undefined && parsed.checkedAt !== undefined) {
            const staleUnknown =
              parsed.status === DomainStatus.Unknown &&
              Date.now() - Date.parse(parsed.checkedAt) > STALE_UNKNOWN_WINDOW_MS;
            const staleAvailable =
              parsed.status === DomainStatus.Available &&
              Date.now() - Date.parse(parsed.checkedAt) > this.#persistentAvailableStaleMs;
            if (!staleUnknown && !staleAvailable) {
              if (!this.#cacheDisabled) this.#cache.set(domain, parsed);
              const durationMs = Date.now() - startTime;
              this.#recordMetrics(parsed, durationMs, true, undefined);
              return { ...parsed, durationMs, fromCache: true };
            }
          }
        } catch {
          // Corrupted cache row — fall through to live lookup
        }
      }
    }

    // 3. Request coalescing (prevent duplicate in-flight lookups)
    const existing = this.#pending.get(domain);
    if (existing !== undefined) return existing;

    const promise = this.#lookup(domain, signal, startTime);
    this.#pending.set(domain, promise);
    try {
      return await promise;
    } finally {
      this.#pending.delete(domain);
    }
  }

  #recordMetrics(
    result: DnsCheckResult,
    durationMs: number,
    fromCache: boolean,
    host?: string,
  ): void {
    if (!this.#onResolution) return;
    let status: 'registered' | 'available' | 'unknown';
    if (result.status === DomainStatus.Registered) status = 'registered';
    else if (result.status === DomainStatus.Available) status = 'available';
    else status = 'unknown';
    // Map 'insecure' to 'unchecked' as we only track valid/unchecked/bogus
    const dnssec = result.dnssec === 'insecure' ? 'unchecked' : (result.dnssec ?? 'unchecked');
    const stats: {
      durationMs: number;
      status: 'registered' | 'available' | 'unknown';
      dnssec: 'valid' | 'unchecked' | 'bogus';
      fromCache: boolean;
      host?: string;
    } = {
      durationMs,
      status,
      dnssec,
      fromCache,
    };
    if (host !== undefined) stats.host = host;
    this.#onResolution(stats);
  }

  async #lookup(
    domain: string,
    _signal?: AbortSignal,
    startTime?: number,
  ): Promise<DnsCheckResult> {
    const checkedAt = new Date().toISOString();
    const lookupStartTime = startTime ?? Date.now();

    // Select healthy host for this lookup
    const host = this.#selectHealthyHost();
    if (!host) {
      // No healthy hosts — this should not happen if fallback is configured,
      // but if it does, return Unknown
      const result: DnsCheckResult = {
        domain,
        status: DomainStatus.Unknown,
        checkedAt,
        dnssec: 'unchecked',
      };
      this.#setCaches(domain, result);
      const durationMs = Date.now() - lookupStartTime;
      this.#recordMetrics(result, durationMs, false, undefined);
      return { ...result, durationMs, fromCache: false };
    }

    try {
      const resolveFn = (s?: AbortSignal): Promise<boolean | undefined> =>
        this.#resolveDomainOnHost(host, domain, s);

      let resolved: boolean | undefined;

      if (this.#rateLimiter && this.#retryPolicy) {
        await this.#rateLimiter.acquire();
        resolved = await withRetry(resolveFn, `unbound:${domain}`, this.#retryPolicy, undefined);
      } else if (this.#rateLimiter) {
        await this.#rateLimiter.acquire();
        resolved = await resolveFn(undefined);
      } else if (this.#retryPolicy) {
        resolved = await withRetry(resolveFn, `unbound:${domain}`, this.#retryPolicy, undefined);
      } else {
        resolved = await resolveFn(undefined);
      }

      // Record success on host
      this.#recordHostSuccess(host);

      // DNSSEC status is a resolver-level fact, not a per-domain one:
      // node:dns exposes no AD flag, so a per-domain probe can't tell "this
      // zone validated" from "this zone isn't signed". healthCheck() proves
      // validation once at boot via a negative-control probe; we stamp that
      // proof here rather than re-querying. See class doc comment.
      //
      // dnssecMode controls how Available verdicts are stamped:
      // - 'strict': Only 'valid' when validation proven active (conservative)
      // - 'permissive': 'valid' when validation active (treats unsigned zones as acceptable)
      // - 'disabled': 'unchecked' always (DNSSEC not required)
      let dnssecStatus: DnsCheckResult['dnssec'];
      const hostHealth = this.#hostHealth.get(host);
      const hostDnssecValid = hostHealth?.dnssecValid ?? false;
      if (!this.#dnssecValidationEnabled || this.#dnssecMode === 'disabled') {
        dnssecStatus = 'unchecked';
      } else if (this.#dnssecMode === 'permissive') {
        // In permissive mode, if the resolver validates DNSSEC, we treat both
        // validated (valid) and unsigned (insecure) zones as acceptable for
        // Available verdicts. Since node:dns can't distinguish per-query, we
        // stamp 'valid' when validation is proven active on the host.
        dnssecStatus = hostDnssecValid ? 'valid' : 'unchecked';
      } else {
        // 'strict' mode (default): only stamp 'valid' when validation proven
        dnssecStatus = hostDnssecValid ? 'valid' : 'unchecked';
      }

      if (resolved !== undefined) {
        const status = resolved ? DomainStatus.Registered : DomainStatus.Available;

        const result: DnsCheckResult = {
          domain,
          status,
          checkedAt,
          dnssec: dnssecStatus,
        };
        this.#setCaches(domain, result);
        const durationMs = Date.now() - lookupStartTime;
        this.#recordMetrics(result, durationMs, false, host);
        return { ...result, durationMs, fromCache: false };
      }

      const unknown: DnsCheckResult = {
        domain,
        status: DomainStatus.Unknown,
        checkedAt,
        dnssec: dnssecStatus,
      };
      this.#setCaches(domain, unknown);
      const unknownDurationMs = Date.now() - lookupStartTime;
      this.#recordMetrics(unknown, unknownDurationMs, false, host);
      return { ...unknown, durationMs: unknownDurationMs, fromCache: false };
    } catch (err) {
      // Mark host unhealthy on error (unless aborted)
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        this.#markHostUnhealthy(host, String(err));
      }
      const result: DnsCheckResult = {
        domain,
        status: DomainStatus.Unknown,
        checkedAt,
        dnssec: 'unchecked',
      };
      this.#setCaches(domain, result);
      const durationMs = Date.now() - lookupStartTime;
      this.#recordMetrics(result, durationMs, false, host);
      return { ...result, durationMs, fromCache: false };
    }
  }

  /**
   * Write to both in-memory and persistent caches (persistent is non-fatal).
   * Unknown results are never persisted: they usually mean a transient
   * resolver failure, and freezing them for the full persistent TTL would
   * block the domain for days. They stay in the in-memory cache only, for
   * within-run deduplication.
   */
  #setCaches(domain: string, result: DnsCheckResult): void {
    if (!this.#cacheDisabled) this.#cache.set(domain, result);
    if (this.#persistentCache !== undefined && result.status !== DomainStatus.Unknown) {
      const ttlDays = this.#persistentCacheTtlHours / 24;
      this.#persistentCache.set(domain, this.name, JSON.stringify(result), ttlDays).catch(() => {
        /* Non-fatal: in-memory cache still works */
      });
    }
  }

  async #resolveDomainOnHost(
    host: string,
    domain: string,
    signal?: AbortSignal,
  ): Promise<boolean | undefined> {
    // With Unbound, we use a simple two-phase resolution: A then NS+SOA
    // This mirrors the conservative approach in NodeDnsProvider
    try {
      // Phase 1: A record only — fastest path
      const aOutcome = await this.#resolveWithTimeout(
        host,
        domain,
        'A',
        this.#lookupTimeoutMs,
        signal,
      )
        .then(() => true as const)
        .catch((err: unknown) => {
          const e = err as { code?: string; name?: string };
          if (e.name === 'AbortError') return 'aborted' as const;
          if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') return 'nxdomain' as const;
          if (e.code === 'ETIMEOUT' || e.code === 'ESOCKETTIMEOUT') return 'timeout' as const;
          return 'error' as const;
        });

      if (aOutcome === true) return true;
      if (aOutcome === 'aborted') return undefined;

      // Phase 2: NS + SOA in parallel — catch domains registered without A records
      const fallbackAc = new AbortController();
      const fallbackSignal = signal
        ? AbortSignal.any([signal, fallbackAc.signal])
        : fallbackAc.signal;

      const fallbackTypes: DnsRecordType[] = ['NS', 'SOA'];
      const fallbackOutcomes = await Promise.all(
        fallbackTypes.map((type) =>
          this.#resolveWithTimeout(host, domain, type, this.#lookupTimeoutMs, fallbackSignal)
            .then(() => {
              fallbackAc.abort();
              return {
                resolved: true as const,
                code: undefined as string | undefined,
                aborted: false as const,
              };
            })
            .catch((err: unknown) => {
              const e = err as { code?: string; name?: string };
              return {
                resolved: false as const,
                code: e.code,
                aborted: e.name === ('AbortError' as const),
              };
            }),
        ),
      );

      for (const o of fallbackOutcomes) {
        if (o.resolved) return true;
      }

      let anyTimeout = false;
      for (const o of fallbackOutcomes) {
        if (o.aborted) continue;
        const c = o.code;
        if (c === 'ETIMEOUT' || c === 'ESOCKETTIMEOUT') {
          anyTimeout = true;
        } else if (c !== 'ENOTFOUND' && c !== 'ENODATA' && c !== undefined) {
          return undefined;
        }
      }

      if (anyTimeout) {
        logger.warn({ domain, host }, 'Unbound: A and NS/SOA both timed out');
        return undefined;
      }

      return false;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      logger.debug({ domain, host, err }, 'Unbound resolution error');
      return undefined;
    }
  }

  /** Resolve a single record type on a specific host with timeout and abort support. */
  #resolveWithTimeout(
    host: string,
    domain: string,
    recordType: DnsRecordType,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const health = this.#hostHealth.get(host);
    if (!health) {
      return Promise.reject(new Error(`Host ${host} not found`));
    }
    const resolver = health.resolver;

    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(`DNS ${recordType} lookup timed out for ${domain} on ${host}`);
        (err as { code?: string }).code = 'ETIMEOUT';
        reject(err);
      }, timeoutMs);

      if (signal?.aborted) {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      const abortHandler = (): void => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', abortHandler, { once: true });

      resolver.resolve(domain, recordType, (err, addresses) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
        if (err !== null) {
          reject(err);
        } else if (Array.isArray(addresses) && addresses.length > 0) {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  async checkBulk(
    domains: string[],
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult[]> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // If in fallback mode and fallback provider exists, delegate to it
    if (this.#usingFallback && this.#fallbackProvider !== undefined) {
      return this.#fallbackProvider.checkBulk(domains, signal, options);
    }

    const results: DnsCheckResult[] = new Array(domains.length);
    let nextIndex = 0;
    let activeWorkers = 0;
    let done = false;

    return new Promise<DnsCheckResult[]>((resolve, reject) => {
      const onAbort = (): void => {
        done = true;
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal !== undefined) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const worker = async (): Promise<void> => {
        while (!done) {
          const idx = nextIndex++;
          if (idx >= domains.length) {
            activeWorkers--;
            if (activeWorkers === 0) {
              cleanup();
              resolve(results);
            }
            return;
          }
          try {
            results[idx] = await this.checkAvailability(domains[idx]!, signal, options);
          } catch {
            results[idx] = {
              domain: domains[idx] ?? 'unknown',
              status: DomainStatus.Unknown,
              checkedAt: new Date().toISOString(),
            };
          }
        }
      };

      const cleanup = (): void => {
        if (signal !== undefined) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      // Spawn worker pool — cap by rate limiter burst capacity when configured
      const burstLimit =
        this.#rateLimiter !== undefined && Number.isFinite(this.#rateLimiter.maxTokens)
          ? this.#rateLimiter.maxTokens
          : this.#bulkConcurrency;
      const concurrency = Math.min(this.#bulkConcurrency, burstLimit, domains.length);
      activeWorkers = concurrency > 0 ? concurrency : 1;
      for (let i = 0; i < concurrency; i++) {
        void worker();
      }
    });
  }
}
