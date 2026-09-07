// SPDX-License-Identifier: AGPL-3.0-only
import type { DnsCheckResult } from '../../types/domain-status.js';
import type {
  DnsProvider,
  DnsCheckOptions,
  DnsResolverGroup,
  ResolvedEndpoints,
} from './dns-provider.js';
import type { DnsLegTelemetry } from './index.js';
import { getLogger } from '../../logger.js';
import {
  runConsensus,
  runConsensusBulk,
  revalidateDisjointness,
  type ConsensusEngineOptions,
  type ConsensusResult,
  type ConsensusStats,
  type TertiaryDnsConfig,
  type SecondaryDnsConfig,
  type ConsensusConfig,
  type DnsConsensusRevalidationMetrics,
} from './consensus-engine.js';

export type { TertiaryDnsConfig, SecondaryDnsConfig, ConsensusConfig };

const logger = getLogger();

export interface DisjointnessValidator {
  isDisjoint(primaryEndpoints: ResolvedEndpoints, secondaryEndpoints: ResolvedEndpoints): boolean;
}

export interface ConsensusDnsProviderOptions {
  primary: DnsProvider;
  secondaryProviders: DnsProvider[];
  tertiaryProviders?: DnsProvider[];
  tertiaryConfig?: TertiaryDnsConfig;
  secondaryConfig?: SecondaryDnsConfig;
  disjointnessValidator: DisjointnessValidator;
  breakers?: unknown;
  telemetry?: DnsLegTelemetry;
  config: ConsensusConfig;
  /** Pre-resolved endpoint data for runtime disjointness validation (ADR-0063/0066/0069) */
  primaryEndpoints?: ResolvedEndpoints;
  secondaryEndpoints?: ResolvedEndpoints;
  secondaryEndpoints2?: ResolvedEndpoints;
  tertiaryEndpoints?: ResolvedEndpoints;
  tertiaryEndpoints2?: ResolvedEndpoints;
  /** Resolver groups used by each leg — required for privacy-mode-compliant re-validation */
  primaryGroups?: DnsResolverGroup[];
  secondaryGroups?: DnsResolverGroup[];
  secondaryGroups2?: DnsResolverGroup[];
  tertiaryGroups?: DnsResolverGroup[] | undefined;
  tertiaryGroups2?: DnsResolverGroup[] | undefined;
  /** Re-validation interval in ms (default: 600000 = 10min). Set to 0 to disable. */
  revalidationIntervalMs?: number;
  /** Optional metrics callback for revalidation runs (Prometheus observability) */
  revalidationMetrics?: DnsConsensusRevalidationMetrics;
}

export class ConsensusDnsProvider implements DnsProvider {
  readonly name = 'ConsensusDnsProvider';

  #engineOptions: ConsensusEngineOptions;
  #revalidationIntervalMs: number;
  #revalidationTimer: ReturnType<typeof setInterval> | undefined;
  #primaryEndpoints: ResolvedEndpoints | undefined;
  #secondaryEndpoints: ResolvedEndpoints | undefined;
  #revalidationMetrics: DnsConsensusRevalidationMetrics | undefined;
  #consensusStats: ConsensusStats = {
    verified: 0,
    disagreed: 0,
    unverifiable: 0,
    degraded: false,
    tertiaryRescued: 0,
  };

  constructor(options: ConsensusDnsProviderOptions) {
    this.#revalidationIntervalMs = options.revalidationIntervalMs ?? 600_000; // 10min default

    const secondaryConfig = options.secondaryConfig ?? options.config.secondaryConfig;
    const tertiaryConfig = options.tertiaryConfig ?? options.config.tertiaryConfig;

    // Derive provider arrays: explicit arrays win, else fall back to
    // secondaryConfig/tertiaryConfig (single → [primary], dual → [primary, secondary]).
    const secondaryProviders =
      options.secondaryProviders.length > 0
        ? options.secondaryProviders
        : secondaryConfig !== undefined
          ? secondaryConfig.strategy === 'dual-redundant'
            ? [secondaryConfig.primary, secondaryConfig.secondary]
            : [secondaryConfig.primary]
          : [];
    const tertiaryProviders =
      options.tertiaryProviders !== undefined && options.tertiaryProviders.length > 0
        ? options.tertiaryProviders
        : tertiaryConfig !== undefined
          ? tertiaryConfig.strategy === 'dual-redundant'
            ? [tertiaryConfig.primary, tertiaryConfig.secondary]
            : [tertiaryConfig.primary]
          : [];

    // Build engine options from constructor options (ADR-0069)
    const engineOptions: ConsensusEngineOptions = {
      primary: options.primary,
      secondaryProviders,
      tertiaryProviders,
      disjointnessValidator: options.disjointnessValidator,
      config: {
        requiredConfirmations: options.config.requiredConfirmations,
        degradedRatio: options.config.degradedRatio,
        degradedMin: options.config.degradedMin,
        revalidationIntervalMs: this.#revalidationIntervalMs,
      },
      primaryEndpoints: options.primaryEndpoints,
      secondaryEndpoints: options.secondaryEndpoints,
      primaryGroups: options.primaryGroups,
      secondaryGroups: options.secondaryGroups,
      revalidationIntervalMs: this.#revalidationIntervalMs,
    };
    if (options.telemetry !== undefined) {
      engineOptions.telemetry = options.telemetry;
    }
    if (options.secondaryEndpoints2 !== undefined) {
      engineOptions.secondaryEndpoints2 = options.secondaryEndpoints2;
    }
    if (options.tertiaryEndpoints !== undefined) {
      engineOptions.tertiaryEndpoints = options.tertiaryEndpoints;
    }
    if (options.tertiaryEndpoints2 !== undefined) {
      engineOptions.tertiaryEndpoints2 = options.tertiaryEndpoints2;
    }
    if (options.secondaryGroups2 !== undefined) {
      engineOptions.secondaryGroups2 = options.secondaryGroups2;
    }
    if (options.tertiaryGroups !== undefined) {
      engineOptions.tertiaryGroups = options.tertiaryGroups;
    }
    if (options.tertiaryGroups2 !== undefined) {
      engineOptions.tertiaryGroups2 = options.tertiaryGroups2;
    }

    // Only include secondaryConfig/tertiaryConfig if defined (exactOptionalPropertyTypes)
    if (secondaryConfig !== undefined) {
      engineOptions.secondaryConfig = secondaryConfig;
    }
    if (tertiaryConfig !== undefined) {
      engineOptions.tertiaryConfig = tertiaryConfig;
    }

    this.#engineOptions = engineOptions;

    // Store endpoints for revalidation check
    this.#primaryEndpoints = options.primaryEndpoints;
    this.#secondaryEndpoints = options.secondaryEndpoints;
    this.#revalidationMetrics = options.revalidationMetrics;

    // Start periodic re-validation if interval > 0 and endpoints are available
    if (this.#revalidationIntervalMs > 0 && this.#primaryEndpoints && this.#secondaryEndpoints) {
      this.#startPeriodicRevalidation();
    }
  }

  /** Get aggregated consensus stats for the current run. */
  getConsensusStats(): ConsensusStats {
    return { ...this.#consensusStats };
  }

  /** Reset consensus stats for a new run. */
  resetConsensusStats(): void {
    this.#consensusStats = {
      verified: 0,
      disagreed: 0,
      unverifiable: 0,
      degraded: false,
      tertiaryRescued: 0,
    };
  }

  /** Accumulate stats from a single consensus result. */
  #accumulateStats(stats: ConsensusResult['consensusStats']): void {
    this.#consensusStats.verified += stats.verified;
    this.#consensusStats.disagreed += stats.disagreed;
    this.#consensusStats.unverifiable += stats.unverifiable;
    if (stats.degraded) this.#consensusStats.degraded = true;
    this.#consensusStats.tertiaryRescued += stats.tertiaryRescued ?? 0;
    this.#consensusStats.secondaryRescued =
      (this.#consensusStats.secondaryRescued ?? 0) + (stats.secondaryRescued ?? 0);
  }

  /** Start periodic runtime disjointness re-validation */
  #startPeriodicRevalidation(): void {
    this.#revalidationTimer = setInterval(async () => {
      try {
        await this.#revalidateDisjointness();
      } catch (err) {
        logger.error({ err }, 'DNS consensus periodic re-validation failed');
      }
    }, this.#revalidationIntervalMs).unref();
    logger.info(
      { intervalMs: this.#revalidationIntervalMs },
      'DNS consensus periodic re-validation started',
    );
  }

  /** Stop periodic re-validation (for graceful shutdown) */
  #stopPeriodicRevalidation(): void {
    if (this.#revalidationTimer) {
      clearInterval(this.#revalidationTimer);
      this.#revalidationTimer = undefined;
    }
  }

  /** Perform runtime disjointness re-validation using live DNS resolution via pinned resolver groups */
  async #revalidateDisjointness(): Promise<void> {
    await revalidateDisjointness(this.#engineOptions, 2000, this.#revalidationMetrics);
  }

  /** Override dispose to also stop revalidation */
  dispose(): void {
    this.#stopPeriodicRevalidation();
    this.#engineOptions.primary.dispose?.();
    for (const p of this.#engineOptions.secondaryProviders) p.dispose?.();
    for (const p of this.#engineOptions.tertiaryProviders) p.dispose?.();
    this.#engineOptions.tertiaryConfig?.primary.dispose?.();
    this.#engineOptions.tertiaryConfig?.secondary.dispose?.();
    this.#engineOptions.secondaryConfig?.primary.dispose?.();
    this.#engineOptions.secondaryConfig?.secondary.dispose?.();
  }

  async checkAvailability(
    domain: string,
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult> {
    const result = await runConsensus(domain, this.#engineOptions, signal, options);
    this.#accumulateStats(result.consensusStats);
    return result.result;
  }

  async checkBulk(
    domains: string[],
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult[]> {
    const results = await runConsensusBulk(domains, this.#engineOptions, signal, options);
    for (const r of results) {
      this.#accumulateStats(r.consensusStats);
    }
    return results.map((r) => r.result);
  }

  clearCache(): void {
    this.#engineOptions.primary.clearCache();
    for (const p of this.#engineOptions.secondaryProviders) p.clearCache();
    for (const p of this.#engineOptions.tertiaryProviders) p.clearCache();
  }

  pruneCache(): number {
    let total = 0;
    total += this.#engineOptions.primary.pruneCache();
    for (const p of this.#engineOptions.secondaryProviders) total += p.pruneCache();
    for (const p of this.#engineOptions.tertiaryProviders) total += p.pruneCache();
    return total;
  }
}

// Re-export for backward compatibility
export { runConsensus, runConsensusBulk, revalidateDisjointness } from './consensus-engine.js';
export type {
  ConsensusEngineOptions,
  ConsensusResult,
  ConsensusStats,
  ConsensusConfig as ConsensusDnsConfig,
} from './consensus-engine.js';
