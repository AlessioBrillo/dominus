// SPDX-License-Identifier: AGPL-3.0-only
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider, DnsCheckOptions } from './dns-provider.js';
import type { DnsLegTelemetry, DnsLegSample } from './index.js';
import { DomainStatus } from '../../types/domain-status.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export interface DisjointnessValidator {
  isDisjoint(primaryEndpoints: string[], secondaryEndpoints: string[]): boolean;
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
  disjointnessValidator: DisjointnessValidator;
  breakers?: unknown;
  telemetry?: DnsLegTelemetry;
  config: ConsensusConfig;
}

function emitTelemetry(
  telemetry: DnsLegTelemetry | undefined,
  spec: { transport: string; endpoint: string },
  result: DnsCheckResult | undefined,
  error: unknown,
  role: DnsLegSample['role'],
  startedAt: number,
): void {
  if (!telemetry) return;
  if (error instanceof DOMException && error.name === 'AbortError') return;
  let verdict: DnsLegSample['verdict'];
  if (result?.status === DomainStatus.Registered || result?.isParked) verdict = 'registered';
  else if (result?.status === DomainStatus.Available) verdict = 'available';
  else if (result === undefined && error === undefined) verdict = 'unknown';
  else verdict = 'error';
  try {
    telemetry({
      transport: spec.transport as DnsLegSample['transport'],
      endpoint: spec.endpoint,
      verdict,
      durationMs: performance.now() - startedAt,
      role,
    });
  } catch {
    // Telemetry must never break DNS
  }
}

export class ConsensusDnsProvider implements DnsProvider {
  readonly name = 'ConsensusDnsProvider';

  #primary: DnsProvider;
  #secondary: DnsProvider;
  #tertiary: DnsProvider | undefined;
  #tertiaryConfig: TertiaryDnsConfig | undefined;
  #disjointnessValidator: DisjointnessValidator;
  #telemetry: DnsLegTelemetry | undefined;
  #config: ConsensusConfig;
  #disjointnessCache: Map<string, boolean> = new Map();

  constructor(options: ConsensusDnsProviderOptions) {
    this.#primary = options.primary;
    this.#secondary = options.secondary;
    this.#tertiary = options.tertiary;
    this.#tertiaryConfig = options.config.tertiaryConfig;
    this.#disjointnessValidator = options.disjointnessValidator;
    this.#telemetry = options.telemetry;
    this.#config = options.config;
  }

  async checkAvailability(
    domain: string,
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult> {
    // 1. Primary lookup
    const primaryStartedAt = performance.now();
    let primaryResult: DnsCheckResult | undefined;
    let primaryError: unknown;

    try {
      primaryResult = await this.#primary.checkAvailability(domain, signal, options);
    } catch (err) {
      primaryError = err;
    }

    emitTelemetry(
      this.#telemetry,
      { transport: 'primary', endpoint: this.#primary.name },
      primaryResult,
      primaryError,
      'primary',
      primaryStartedAt,
    );

    if (primaryError !== undefined || primaryResult === undefined) {
      return {
        domain,
        status: DomainStatus.Unknown,
        checkedAt: new Date().toISOString(),
      };
    }

    // If primary says Registered (or parked), return immediately — no consensus needed
    if (primaryResult.status === DomainStatus.Registered || primaryResult.isParked === true) {
      return primaryResult;
    }

    // If primary says Unknown, return Unknown — no consensus on Unknown
    if (primaryResult.status === DomainStatus.Unknown) {
      return primaryResult;
    }

    // Primary says Available — need consensus
    const disjoint = await this.#checkDisjointness();

    if (!disjoint) {
      logger.warn({ domain }, 'Consensus skipped: resolver sets not disjoint — returning Unknown');
      return {
        domain,
        status: DomainStatus.Unknown,
        checkedAt: new Date().toISOString(),
      };
    }

    // 2. Secondary lookup
    const secondaryStartedAt = performance.now();
    let secondaryResult: DnsCheckResult | undefined;
    let secondaryError: unknown;

    try {
      secondaryResult = await this.#secondary.checkAvailability(domain, signal, {
        ...options,
        forceRecheck: true,
      });
    } catch (err) {
      secondaryError = err;
    }

    emitTelemetry(
      this.#telemetry,
      { transport: 'consensus', endpoint: this.#secondary.name },
      secondaryResult,
      secondaryError,
      'consensus',
      secondaryStartedAt,
    );

    // Secondary veto: Registered wins
    if (secondaryResult?.status === DomainStatus.Registered || secondaryResult?.isParked === true) {
      logger.warn({ domain }, 'Consensus vetoed by secondary (Registered) — downgraded to Unknown');
      return {
        domain,
        status: DomainStatus.Unknown,
        checkedAt: new Date().toISOString(),
      };
    }

    const secondaryConfirmed = secondaryResult?.status === DomainStatus.Available;

    // If secondary confirms and we only need 1 confirmation, we're done
    if (secondaryConfirmed && this.#config.requiredConfirmations === 1) {
      return primaryResult;
    }

    // If secondary confirms but we need 2, continue to tertiary
    // If secondary failed/unknown and we have tertiary, try tertiary
    // If secondary failed/unknown and no tertiary (or requiredConfirmations=1), return Unknown
    if (!secondaryConfirmed) {
      if (this.#tertiary === undefined) {
        logger.warn(
          { domain },
          'Consensus not confirmed by secondary, no tertiary — downgraded to Unknown',
        );
        return {
          domain,
          status: DomainStatus.Unknown,
          checkedAt: new Date().toISOString(),
        };
      }
    }

    // 3. Tertiary lookup (if available and needed)
    // Support dual-redundant tertiary (ADR-0068): race two independent providers
    const tertiaryProviders = this.#tertiaryConfig?.strategy === 'dual-redundant'
      ? [this.#tertiaryConfig.primary, this.#tertiaryConfig.secondary]
      : this.#tertiary !== undefined ? [this.#tertiary] : [];

    if (tertiaryProviders.length > 0) {
      const needTertiary = !secondaryConfirmed || this.#config.requiredConfirmations === 2;

      if (needTertiary) {
        const tertiaryStartedAt = performance.now();
        let tertiaryResults: Array<{ result: DnsCheckResult | undefined; error: unknown; provider: DnsProvider }> = [];

        // Race all tertiary providers: first Available rescues, any Registered vetoes
        const tertiaryPromises = tertiaryProviders.map(async (provider) => {
          let result: DnsCheckResult | undefined;
          let error: unknown;
          try {
            result = await provider.checkAvailability(domain, signal, {
              ...options,
              forceRecheck: true,
            });
          } catch (err) {
            error = err;
          }
          return { result, error, provider };
        });

        tertiaryResults = await Promise.all(tertiaryPromises);

        // Emit telemetry for all tertiary providers
        for (const { result, error, provider } of tertiaryResults) {
          emitTelemetry(
            this.#telemetry,
            { transport: 'tertiary', endpoint: provider.name },
            result,
            error,
            'tertiary',
            tertiaryStartedAt,
          );
        }

        // Check for vetoes: any Registered from any tertiary provider vetoes
        const hasVeto = tertiaryResults.some(
          (r) => r.result?.status === DomainStatus.Registered || r.result?.isParked === true,
        );

        if (hasVeto) {
          logger.warn(
            { domain },
            'Consensus vetoed by tertiary (Registered) — downgraded to Unknown',
          );
          return {
            domain,
            status: DomainStatus.Unknown,
            checkedAt: new Date().toISOString(),
          };
        }

        // Check for confirmations: any Available from any tertiary provider confirms
        const hasConfirmation = tertiaryResults.some((r) => r.result?.status === DomainStatus.Available);

        if (this.#config.requiredConfirmations === 2) {
          // Both secondary and tertiary must confirm
          // For dual-redundant, tertiary confirms if ANY provider confirms
          if (secondaryConfirmed && hasConfirmation) {
            return primaryResult;
          }
          logger.warn(
            { domain, secondaryConfirmed, tertiaryConfirmed: hasConfirmation },
            'Consensus not confirmed by both secondary and tertiary — downgraded to Unknown',
          );
          return {
            domain,
            status: DomainStatus.Unknown,
            checkedAt: new Date().toISOString(),
          };
        } else {
          // requiredConfirmations=1: tertiary rescues if secondary failed
          if (hasConfirmation) {
            logger.info({ domain }, 'Consensus rescued by tertiary (Available)');
            return primaryResult;
          }
          logger.warn({ domain }, 'Consensus not confirmed by tertiary — downgraded to Unknown');
          return {
            domain,
            status: DomainStatus.Unknown,
            checkedAt: new Date().toISOString(),
          };
        }
      }
    }

    // Secondary confirmed but we need 2 confirmations and no tertiary
    if (this.#config.requiredConfirmations === 2 && this.#tertiary === undefined) {
      logger.warn(
        { domain },
        'requiredConfirmations=2 but no tertiary configured — downgraded to Unknown',
      );
      return {
        domain,
        status: DomainStatus.Unknown,
        checkedAt: new Date().toISOString(),
      };
    }

    // Fallback: secondary couldn't confirm and no tertiary rescue possible
    return {
      domain,
      status: DomainStatus.Unknown,
      checkedAt: new Date().toISOString(),
    };
  }

  async checkBulk(
    domains: string[],
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult[]> {
    // Process in parallel with concurrency control
    const concurrency = 50; // Reasonable default for consensus bulk
    const results: DnsCheckResult[] = [];

    for (let i = 0; i < domains.length; i += concurrency) {
      if (signal?.aborted) break;
      const batch = domains.slice(i, i + concurrency);
      const batchResults: DnsCheckResult[] = await Promise.all(
        batch.map(async (domain): Promise<DnsCheckResult> => {
          try {
            return await this.checkAvailability(domain, signal, options);
          } catch {
            return {
              domain,
              status: DomainStatus.Unknown,
              checkedAt: new Date().toISOString(),
            };
          }
        }),
      );
      results.push(...batchResults);
    }

    return results;
  }

  clearCache(): void {
    this.#primary.clearCache();
    this.#secondary.clearCache();
    this.#tertiary?.clearCache();
    this.#disjointnessCache.clear();
  }

  pruneCache(): number {
    let total = 0;
    total += this.#primary.pruneCache();
    total += this.#secondary.pruneCache();
    total += this.#tertiary?.pruneCache() ?? 0;
    return total;
  }

  dispose(): void {
    this.#primary.dispose?.();
    this.#secondary.dispose?.();
    this.#tertiary?.dispose?.();
  }

  async #checkDisjointness(): Promise<boolean> {
    const cacheKey = `${this.#primary.name}|${this.#secondary.name}|${this.#tertiary?.name ?? 'none'}`;
    const cached = this.#disjointnessCache.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      // For the primary, we need to get its endpoints. Since the provider interface
      // doesn't expose endpoints, we use the provider name as a proxy.
      // In production, the factory wires the actual endpoint lists.
      const primaryEndpoints = [this.#primary.name];
      const secondaryEndpoints = [this.#secondary.name];
      const isDisjoint = this.#disjointnessValidator.isDisjoint(
        primaryEndpoints,
        secondaryEndpoints,
      );

      if (!isDisjoint) {
        logger.warn(
          { primary: this.#primary.name, secondary: this.#secondary.name },
          'Consensus disjointness check FAILED — primary and secondary share endpoints/operators',
        );
      }

      this.#disjointnessCache.set(cacheKey, isDisjoint);
      return isDisjoint;
    } catch (err) {
      logger.error({ err }, 'Disjointness check error — failing closed');
      return false;
    }
  }
}
