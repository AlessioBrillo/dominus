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
import { runConsensus, runConsensusBulk, revalidateDisjointness, type ConsensusEngineOptions } from './consensus-engine.js';

const logger = getLogger();

export interface DisjointnessValidator {
  isDisjoint(primaryEndpoints: ResolvedEndpoints, secondaryEndpoints: ResolvedEndpoints): boolean;
}

export interface TertiaryDnsConfig {
  primary: DnsProvider;
  secondary: DnsProvider;
  strategy: 'dual-redundant' | 'single';
}

export interface ConsensusConfig {
  requiredConfirmations: 1 | 2;
  degradedRatio: number;
  degradedMin: number;
  tertiaryConfig?: TertiaryDnsConfig;
}

export interface ConsensusDnsProviderOptions {
  primary: DnsProvider;
  secondary: DnsProvider;
  tertiary?: DnsProvider;
  tertiaryConfig?: TertiaryDnsConfig;
  disjointnessValidator: DisjointnessValidator;
  breakers?: unknown;
  telemetry?: DnsLegTelemetry;
  config: ConsensusConfig;
  /** Pre-resolved endpoint data for runtime disjointness validation (ADR-0063/0066) */
  primaryEndpoints?: ResolvedEndpoints;
  secondaryEndpoints?: ResolvedEndpoints;
  tertiaryEndpoints?: ResolvedEndpoints;
  /** Resolver groups used by each leg — required for privacy-mode-compliant re-validation */
  primaryGroups?: DnsResolverGroup[];
  secondaryGroups?: DnsResolverGroup[];
  tertiaryGroups?: DnsResolverGroup[] | undefined;
  /** Re-validation interval in ms (default: 600000 = 10min). Set to 0 to disable. */
  revalidationIntervalMs?: number;
}

export class ConsensusDnsProvider implements DnsProvider {
  readonly name = 'ConsensusDnsProvider';

  #engineOptions: ConsensusEngineOptions;
  #revalidationIntervalMs: number;
  #revalidationTimer: ReturnType<typeof setInterval> | undefined;
  #primaryEndpoints: ResolvedEndpoints | undefined;
  #secondaryEndpoints: ResolvedEndpoints | undefined;

  constructor(options: ConsensusDnsProviderOptions) {
    this.#revalidationIntervalMs = options.revalidationIntervalMs ?? 600_000; // 10min default

    // Build engine options from constructor options
    const engineOptions: ConsensusEngineOptions = {
      primary: options.primary,
      secondary: options.secondary,
      disjointnessValidator: options.disjointnessValidator,
      config: {
        requiredConfirmations: options.config.requiredConfirmations,
        degradedRatio: options.config.degradedRatio,
        degradedMin: options.config.degradedMin,
        revalidationIntervalMs: this.#revalidationIntervalMs,
      },
      primaryEndpoints: options.primaryEndpoints,
      secondaryEndpoints: options.secondaryEndpoints,
      tertiaryEndpoints: options.tertiaryEndpoints,
      primaryGroups: options.primaryGroups,
      secondaryGroups: options.secondaryGroups,
      tertiaryGroups: options.tertiaryGroups,
      revalidationIntervalMs: this.#revalidationIntervalMs,
    };

    // Only include tertiary if defined (exactOptionalPropertyTypes)
    if (options.tertiary !== undefined) {
      engineOptions.tertiary = options.tertiary;
    }

    // Only include tertiaryConfig if defined (exactOptionalPropertyTypes)
    if (options.config.tertiaryConfig !== undefined) {
      engineOptions.tertiaryConfig = options.config.tertiaryConfig;
    }

    this.#engineOptions = engineOptions;

    // Store endpoints for revalidation check
    this.#primaryEndpoints = options.primaryEndpoints;
    this.#secondaryEndpoints = options.secondaryEndpoints;

    // Start periodic re-validation if interval > 0 and endpoints are available
    if (this.#revalidationIntervalMs > 0 && this.#primaryEndpoints && this.#secondaryEndpoints) {
      this.#startPeriodicRevalidation();
    }
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
    await revalidateDisjointness(this.#engineOptions, 2000);
  }

  /** Override dispose to also stop revalidation */
  dispose(): void {
    this.#stopPeriodicRevalidation();
    this.#engineOptions.primary.dispose?.();
    this.#engineOptions.secondary.dispose?.();
    this.#engineOptions.tertiaryConfig?.primary.dispose?.();
    this.#engineOptions.tertiaryConfig?.secondary.dispose?.();
  }

  async checkAvailability(
    domain: string,
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult> {
    const result = await runConsensus(domain, this.#engineOptions, signal, options);
    return result.result;
  }

  async checkBulk(
    domains: string[],
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult[]> {
    const results = await runConsensusBulk(domains, this.#engineOptions, signal, options);
    return results.map((r) => r.result);
  }

  clearCache(): void {
    this.#engineOptions.primary.clearCache();
    this.#engineOptions.secondary.clearCache();
    this.#engineOptions.tertiaryConfig?.primary.clearCache();
    this.#engineOptions.tertiaryConfig?.secondary.clearCache();
  }

  pruneCache(): number {
    let total = 0;
    total += this.#engineOptions.primary.pruneCache();
    total += this.#engineOptions.secondary.pruneCache();
    total += this.#engineOptions.tertiaryConfig?.primary.pruneCache() ?? 0;
    total += this.#engineOptions.tertiaryConfig?.secondary.pruneCache() ?? 0;
    return total;
  }
}

// Re-export for backward compatibility
export { runConsensus, runConsensusBulk, revalidateDisjointness } from './consensus-engine.js';
export type { ConsensusEngineOptions, ConsensusResult } from './consensus-engine.js';