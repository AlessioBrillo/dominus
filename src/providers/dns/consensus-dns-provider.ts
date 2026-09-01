// SPDX-License-Identifier: AGPL-3.0-only
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider, DnsCheckOptions, ResolvedEndpoints } from './dns-provider.js';
import type { DnsLegTelemetry, DnsLegSample } from './index.js';
import { DomainStatus } from '../../types/domain-status.js';
import { getLogger } from '../../logger.js';

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
  /** Re-validation interval in ms (default: 600000 = 10min). Set to 0 to disable. */
  revalidationIntervalMs?: number;
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
  #primaryEndpoints: ResolvedEndpoints | undefined;
  #secondaryEndpoints: ResolvedEndpoints | undefined;
  #revalidationIntervalMs: number;
  #revalidationTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: ConsensusDnsProviderOptions) {
    this.#primary = options.primary;
    this.#secondary = options.secondary;
    this.#tertiary = options.tertiary;
    this.#tertiaryConfig = options.config.tertiaryConfig;
    this.#disjointnessValidator = options.disjointnessValidator;
    this.#telemetry = options.telemetry;
    this.#config = options.config;
    this.#primaryEndpoints = options.primaryEndpoints;
    this.#secondaryEndpoints = options.secondaryEndpoints;
    this.#revalidationIntervalMs = options.revalidationIntervalMs ?? 600_000; // 10min default

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

  /** Perform runtime disjointness re-validation using live DNS resolution */
  async #revalidateDisjointness(): Promise<void> {
    if (!this.#primaryEndpoints || !this.#secondaryEndpoints) return;

    try {
      // Re-resolve primary and secondary endpoints
      // Note: We need the original resolver groups to re-resolve. Since we don't have them,
      // we re-validate using the existing endpoint details by checking if their IPs still match.
      // This is a lightweight check - full re-resolution would require access to resolver groups.

      // For now, check if anycast overlaps have changed by re-resolving endpoint hostnames
      const primaryDetails = this.#primaryEndpoints.endpointDetails;
      const secondaryDetails = this.#secondaryEndpoints.endpointDetails;

      if (primaryDetails.length === 0 || secondaryDetails.length === 0) return;

      // Re-resolve hostnames for endpoints that have them
      const { default: dns } = await import('node:dns/promises');
      const timeoutMs = 2000;

      // Check primary-secondary overlap
      for (const primary of primaryDetails) {
        if (primary.ips.size === 0 || !primary.hostname) continue;

        for (const secondary of secondaryDetails) {
          if (secondary.ips.size === 0 || !secondary.hostname) continue;

          try {
            const [primaryA, primaryAaaa, secondaryA, secondaryAaaa] = await Promise.allSettled([
              Promise.race([
                dns.resolve4(primary.hostname!),
                new Promise<string[]>((_, reject) =>
                  setTimeout(() => reject(new Error('timeout')), timeoutMs),
                ),
              ]),
              Promise.race([
                dns.resolve6(primary.hostname!),
                new Promise<string[]>((_, reject) =>
                  setTimeout(() => reject(new Error('timeout')), timeoutMs),
                ),
              ]),
              Promise.race([
                dns.resolve4(secondary.hostname!),
                new Promise<string[]>((_, reject) =>
                  setTimeout(() => reject(new Error('timeout')), timeoutMs),
                ),
              ]),
              Promise.race([
                dns.resolve6(secondary.hostname!),
                new Promise<string[]>((_, reject) =>
                  setTimeout(() => reject(new Error('timeout')), timeoutMs),
                ),
              ]),
            ]);

            const primaryIps = new Set<string>();
            if (primaryA.status === 'fulfilled')
              for (const ip of primaryA.value) primaryIps.add(ip);
            if (primaryAaaa.status === 'fulfilled')
              for (const ip of primaryAaaa.value) primaryIps.add(ip);

            const secondaryIps = new Set<string>();
            if (secondaryA.status === 'fulfilled')
              for (const ip of secondaryA.value) secondaryIps.add(ip);
            if (secondaryAaaa.status === 'fulfilled')
              for (const ip of secondaryAaaa.value) secondaryIps.add(ip);

            const overlappingIps = [...primaryIps].filter((ip) => secondaryIps.has(ip));
            if (overlappingIps.length > 0) {
              const maxIps = Math.max(primaryIps.size, secondaryIps.size);
              const overlapRatio = overlappingIps.length / maxIps;

              if (overlapRatio > 0.5) {
                // Default threshold
                logger.warn(
                  {
                    primaryIdentity: primary.identity,
                    secondaryIdentity: secondary.identity,
                    overlappingIps,
                    overlapRatio: overlapRatio.toFixed(2),
                  },
                  'DNS consensus runtime re-validation: anycast overlap detected — gate may be degraded',
                );
                // Emit metric for alerting
                // Note: metrics collector not available here, would need to be injected
              }
            }
          } catch {
            // Resolution failed, skip this pair
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'DNS consensus re-validation error — continuing with cached validation');
    }
  }

  /** Override dispose to also stop revalidation */
  dispose(): void {
    this.#stopPeriodicRevalidation();
    this.#primary.dispose?.();
    this.#secondary.dispose?.();
    this.#tertiary?.dispose?.();
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
      const hasAnyTertiary = this.#tertiary !== undefined || this.#tertiaryConfig !== undefined;
      if (!hasAnyTertiary) {
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
    const tertiaryProviders =
      this.#tertiaryConfig?.strategy === 'dual-redundant'
        ? [this.#tertiaryConfig.primary, this.#tertiaryConfig.secondary]
        : this.#tertiary !== undefined
          ? [this.#tertiary]
          : [];

    if (tertiaryProviders.length > 0) {
      const needTertiary = !secondaryConfirmed || this.#config.requiredConfirmations === 2;

      if (needTertiary) {
        const tertiaryStartedAt = performance.now();

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

        const tertiaryResults = await Promise.all(tertiaryPromises);

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
        const hasConfirmation = tertiaryResults.some(
          (r) => r.result?.status === DomainStatus.Available,
        );

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

  async #checkDisjointness(): Promise<boolean> {
    const cacheKey = `${this.#primary.name}|${this.#secondary.name}|${this.#tertiary?.name ?? 'none'}`;
    const cached = this.#disjointnessCache.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      // Use pre-resolved endpoints if available (from factory at bootstrap)
      // Otherwise fall back to provider name proxy (backward compatibility)
      let primaryEndpoints: ResolvedEndpoints;
      let secondaryEndpoints: ResolvedEndpoints;

      if (this.#primaryEndpoints && this.#secondaryEndpoints) {
        primaryEndpoints = this.#primaryEndpoints;
        secondaryEndpoints = this.#secondaryEndpoints;
      } else {
        // Fallback: create minimal ResolvedEndpoints from provider names
        primaryEndpoints = {
          flatEndpoints: [this.#primary.name],
          endpointDetails: [],
          operators: new Map(),
          transports: new Map(),
        };
        secondaryEndpoints = {
          flatEndpoints: [this.#secondary.name],
          endpointDetails: [],
          operators: new Map(),
          transports: new Map(),
        };
      }

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
