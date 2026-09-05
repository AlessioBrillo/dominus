// SPDX-License-Identifier: AGPL-3.0-only
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DomainStatus } from '../../types/domain-status.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider } from '../dns/dns-provider.js';
import type { DnsLegSample, DnsLegTelemetry } from '../dns/index.js';
import type { DnsResolverGroup, ResolvedEndpoints } from '../dns/dns-provider.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

/**
 * Creates a dedicated Resolver instance for the given nameservers.
 * This mirrors the pattern in NodeDnsProvider for privacy-mode compliance.
 */
function createResolverForNameservers(nameservers: string[]): Resolver {
  const resolver = new Resolver();
  resolver.setServers(nameservers);
  return resolver;
}

/**
 * Resolves a hostname (A + AAAA) using the provided resolver groups.
 * Uses the same logic as the primary DNS provider: races all lookups in each group,
 * preferring native with pinned nameservers when available.
 * Returns the set of resolved IPs (IPv4 + IPv6).
 */
export async function resolveHostnameViaGroups(
  groups: DnsResolverGroup[],
  hostname: string,
  timeoutMs: number,
): Promise<Set<string>> {
  const ips = new Set<string>();

  for (const group of groups) {
    if (group.fallback) continue; // Skip fallback groups for re-validation

    for (const lookup of group.lookups) {
      try {
        if (lookup.type === 'native') {
          // Use pinned nameservers if available, otherwise system resolver
          const nameservers = lookup.nameservers;
          const resolver =
            nameservers && nameservers.length > 0
              ? createResolverForNameservers(nameservers)
              : new Resolver(); // system resolver

          const [aResult, aaaaResult] = await Promise.allSettled([
            Promise.race([
              resolver.resolve4(hostname),
              new Promise<string[]>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), timeoutMs),
              ),
            ]),
            Promise.race([
              resolver.resolve6(hostname),
              new Promise<string[]>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), timeoutMs),
              ),
            ]),
          ]);

          if (aResult.status === 'fulfilled') {
            for (const ip of aResult.value) ips.add(ip);
          }
          if (aaaaResult.status === 'fulfilled') {
            for (const ip of aaaaResult.value) ips.add(ip);
          }

          // If we got results from a native lookup with pinned nameservers,
          // that's authoritative for this group — don't try other lookups in this group
          if (nameservers && nameservers.length > 0 && ips.size > 0) {
            break;
          }
        } else if (lookup.type === 'doh' && lookup.endpoint) {
          // For DoH, we resolve the DoH endpoint hostname using system resolver
          // (DoH endpoint itself is the resolver, we just need its IPs for anycast check)
          const host = new URL(lookup.endpoint).hostname;
          // Skip if we already resolved this hostname
          if (ips.size > 0 && hostname === host) continue;

          const resolver = new Resolver(); // System resolver for DoH endpoint hostname
          const [aResult, aaaaResult] = await Promise.allSettled([
            Promise.race([
              resolver.resolve4(host),
              new Promise<string[]>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), timeoutMs),
              ),
            ]),
            Promise.race([
              resolver.resolve6(host),
              new Promise<string[]>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), timeoutMs),
              ),
            ]),
          ]);

          if (aResult.status === 'fulfilled') {
            for (const ip of aResult.value) ips.add(ip);
          }
          if (aaaaResult.status === 'fulfilled') {
            for (const ip of aaaaResult.value) ips.add(ip);
          }
        } else if (lookup.type === 'dot' && lookup.endpoint) {
          // For DoT, resolve the endpoint hostname/IP
          const host = lookup.endpoint;
          if (isIP(host) !== 0) {
            ips.add(host); // It's already an IP
          } else {
            const resolver = new Resolver(); // System resolver for DoT endpoint hostname
            const [aResult, aaaaResult] = await Promise.allSettled([
              Promise.race([
                resolver.resolve4(host),
                new Promise<string[]>((_, reject) =>
                  setTimeout(() => reject(new Error('timeout')), timeoutMs),
                ),
              ]),
              Promise.race([
                resolver.resolve6(host),
                new Promise<string[]>((_, reject) =>
                  setTimeout(() => reject(new Error('timeout')), timeoutMs),
                ),
              ]),
            ]);

            if (aResult.status === 'fulfilled') {
              for (const ip of aResult.value) ips.add(ip);
            }
            if (aaaaResult.status === 'fulfilled') {
              for (const ip of aaaaResult.value) ips.add(ip);
            }
          }
        }
      } catch {
        // Resolution failed for this lookup, continue to next
      }
    }

    // If we got IPs from this group, stop (groups are tried sequentially)
    if (ips.size > 0) break;
  }

  return ips;
}

export interface ConsensusConfig {
  requiredConfirmations: 1 | 2;
  degradedRatio: number;
  degradedMin: number;
  revalidationIntervalMs: number;
  tertiaryConfig?: TertiaryDnsConfig;
  secondaryConfig?: SecondaryDnsConfig;
  disabled?: boolean;
  disableReason?: string;
  runtimeDegraded?: boolean;
  requiredAvailable?: number;
  secondaryProvider?: DnsProvider;
  tertiaryProvider?: DnsProvider;
  _primaryGroups?: DnsResolverGroup[];
  _secondaryGroups?: DnsResolverGroup[];
  _secondaryGroups2?: DnsResolverGroup[];
  _tertiaryGroups?: DnsResolverGroup[] | undefined;
  _primaryNameservers?: string[];
  _secondaryNameservers?: string[];
  _tertiaryNameservers?: string[] | undefined;
  anycastDegraded?: boolean;
  authoritativeZoneResolver?: unknown;
  secondaryEndpoints?: string[];
  tertiaryEndpoints?: string[];
  consensusConcurrency?: number;
}

export interface TertiaryDnsConfig {
  primary: DnsProvider;
  secondary: DnsProvider;
  strategy: 'dual-redundant' | 'single';
}

export interface SecondaryDnsConfig {
  primary: DnsProvider;
  secondary: DnsProvider;
  strategy: 'dual-redundant' | 'single';
}

export interface ConsensusEngineOptions {
  primary: DnsProvider;
  secondary: DnsProvider;
  tertiary?: DnsProvider; // Legacy single tertiary mode
  tertiaryConfig?: TertiaryDnsConfig;
  secondaryConfig?: SecondaryDnsConfig;
  disjointnessValidator: {
    isDisjoint(primaryEndpoints: unknown, secondaryEndpoints: unknown): boolean;
  };
  telemetry?: DnsLegTelemetry;
  config: ConsensusConfig;
  primaryEndpoints?: unknown;
  secondaryEndpoints?: unknown;
  tertiaryEndpoints?: unknown;
  primaryGroups?: unknown;
  secondaryGroups?: unknown;
  tertiaryGroups?: unknown;
  revalidationIntervalMs?: number;
}

export interface ConsensusResult {
  result: DnsCheckResult;
  consensusStats: ConsensusStats;
}

export interface ConsensusStats {
  verified: number;
  disagreed: number;
  unverifiable: number;
  degraded: boolean;
  tertiaryRescued: number;
}

// Re-export alias for backward compatibility
export type ConsensusDnsConfig = ConsensusConfig;

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

/**
 * Pure consensus engine logic - no side effects, fully testable.
 * Implements 2-of-3 / 2-of-2+1 consensus with dual-redundant tertiary support.
 */
export async function runConsensus(
  domain: string,
  options: ConsensusEngineOptions,
  signal?: AbortSignal,
  checkOptions?: { forceRecheck?: boolean },
): Promise<ConsensusResult> {
  const { primary, secondary, tertiary, tertiaryConfig, disjointnessValidator, telemetry, config } =
    options;

  const consensusStats = {
    verified: 0,
    disagreed: 0,
    unverifiable: 0,
    degraded: false,
    tertiaryRescued: 0,
  };

  // 1. Primary lookup
  const primaryStartedAt = performance.now();
  let primaryResult: DnsCheckResult | undefined;
  let primaryError: unknown;

  try {
    primaryResult = await primary.checkAvailability(domain, signal, checkOptions);
  } catch (err) {
    primaryError = err;
  }

  emitTelemetry(
    telemetry,
    { transport: 'primary', endpoint: primary.name },
    primaryResult,
    primaryError,
    'primary',
    primaryStartedAt,
  );

  if (primaryError !== undefined || primaryResult === undefined) {
    return {
      result: {
        domain,
        status: DomainStatus.Unknown,
        checkedAt: new Date().toISOString(),
      },
      consensusStats,
    };
  }

  // If primary says Registered (or parked), return immediately — no consensus needed
  if (primaryResult.status === DomainStatus.Registered || primaryResult.isParked === true) {
    return { result: primaryResult, consensusStats };
  }

  // If primary says Unknown, return Unknown — no consensus on Unknown
  if (primaryResult.status === DomainStatus.Unknown) {
    return { result: primaryResult, consensusStats };
  }

  // Primary says Available — need consensus
  // Check disjointness (cached)
  const primaryEndpoints = options.primaryEndpoints;
  const secondaryEndpoints = options.secondaryEndpoints;

  if (primaryEndpoints && secondaryEndpoints) {
    const isDisjoint = disjointnessValidator.isDisjoint(primaryEndpoints, secondaryEndpoints);
    if (!isDisjoint) {
      logger.warn({ domain }, 'Consensus skipped: resolver sets not disjoint — returning Unknown');
      return {
        result: {
          domain,
          status: DomainStatus.Unknown,
          checkedAt: new Date().toISOString(),
        },
        consensusStats,
      };
    }
  }

  // 2. Secondary lookup (dual-redundant or single)
  const secondaryStartedAt = performance.now();

  const secondaryProviders =
    options.secondaryConfig?.strategy === 'dual-redundant'
      ? [options.secondaryConfig.primary, options.secondaryConfig.secondary]
      : [secondary]; // Legacy single secondary mode

  // Race all secondary providers in parallel
  const secondaryPromises = secondaryProviders.map(async (provider) => {
    let result: DnsCheckResult | undefined;
    let error: unknown;
    try {
      result = await provider.checkAvailability(domain, signal, {
        ...checkOptions,
        forceRecheck: true,
      });
    } catch (err) {
      error = err;
    }
    return { result, error, provider };
  });

  const secondaryResults = await Promise.all(secondaryPromises);

  // Emit telemetry for each secondary provider
  for (const { result, error, provider } of secondaryResults) {
    emitTelemetry(
      telemetry,
      { transport: 'consensus', endpoint: provider.name },
      result,
      error,
      'consensus',
      secondaryStartedAt,
    );
  }

  // Check for vetoes: any Registered from any secondary provider vetoes
  const hasVeto = secondaryResults.some(
    (r) => r.result?.status === DomainStatus.Registered || r.result?.isParked === true,
  );

  if (hasVeto) {
    logger.warn({ domain }, 'Consensus vetoed by secondary (Registered) — downgraded to Unknown');
    consensusStats.disagreed = 1;
    return {
      result: {
        domain,
        status: DomainStatus.Unknown,
        checkedAt: new Date().toISOString(),
      },
      consensusStats,
    };
  }

  // Check for confirmations: any Available from any secondary provider confirms
  let secondaryConfirmed = secondaryResults.some(
    (r) => r.result?.status === DomainStatus.Available,
  );

  // If secondary confirms and we only need 1 confirmation, we're done
  if (secondaryConfirmed && config.requiredConfirmations === 1) {
    consensusStats.verified = 1;
    return { result: primaryResult, consensusStats };
  }

  // If secondary confirms but we need 2, continue to tertiary
  // If secondary failed/unknown and we have tertiary, try tertiary
  // If secondary failed/unknown and no tertiary, return Unknown
  if (!secondaryConfirmed) {
    const hasAnyTertiary = tertiaryConfig !== undefined || tertiary !== undefined;
    if (!hasAnyTertiary) {
      logger.warn(
        { domain },
        'Consensus not confirmed by secondary, no tertiary — downgraded to Unknown',
      );
      consensusStats.unverifiable = 1;
      return {
        result: {
          domain,
          status: DomainStatus.Unknown,
          checkedAt: new Date().toISOString(),
        },
        consensusStats,
      };
    }
  }

  // 3. Tertiary lookup (dual-redundant or single)
  const tertiaryProviders =
    tertiaryConfig?.strategy === 'dual-redundant'
      ? [tertiaryConfig.primary, tertiaryConfig.secondary]
      : tertiary !== undefined
        ? [tertiary] // Legacy single tertiary mode
        : [];

  if (tertiaryProviders.length > 0) {
    const needTertiary = !secondaryConfirmed || config.requiredConfirmations === 2;

    if (needTertiary) {
      const tertiaryStartedAt = performance.now();

      const tertiaryPromises = tertiaryProviders.map(async (provider) => {
        let result: DnsCheckResult | undefined;
        let error: unknown;
        try {
          result = await provider.checkAvailability(domain, signal, {
            ...checkOptions,
            forceRecheck: true,
          });
        } catch (err) {
          error = err;
        }
        return { result, error, provider };
      });

      const tertiaryResults = await Promise.all(tertiaryPromises);

      for (const { result, error, provider } of tertiaryResults) {
        emitTelemetry(
          telemetry,
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
        consensusStats.disagreed = 1;
        return {
          result: {
            domain,
            status: DomainStatus.Unknown,
            checkedAt: new Date().toISOString(),
          },
          consensusStats,
        };
      }

      // Check for confirmations: any Available from any tertiary provider confirms
      const hasConfirmation = tertiaryResults.some(
        (r) => r.result?.status === DomainStatus.Available,
      );

      if (config.requiredConfirmations === 2) {
        // Both secondary and tertiary must confirm
        if (secondaryConfirmed && hasConfirmation) {
          consensusStats.verified = 1;
          if (!secondaryConfirmed) consensusStats.tertiaryRescued = 1;
          return { result: primaryResult, consensusStats };
        }
        logger.warn(
          { domain, secondaryConfirmed, tertiaryConfirmed: hasConfirmation },
          'Consensus not confirmed by both secondary and tertiary — downgraded to Unknown',
        );
        consensusStats.unverifiable = 1;
        return {
          result: {
            domain,
            status: DomainStatus.Unknown,
            checkedAt: new Date().toISOString(),
          },
          consensusStats,
        };
      } else {
        // requiredConfirmations=1: tertiary rescues if secondary failed
        if (hasConfirmation) {
          logger.info({ domain }, 'Consensus rescued by tertiary (Available)');
          consensusStats.verified = 1;
          if (!secondaryConfirmed) consensusStats.tertiaryRescued = 1;
          return { result: primaryResult, consensusStats };
        }
        logger.warn({ domain }, 'Consensus not confirmed by tertiary — downgraded to Unknown');
        consensusStats.unverifiable = 1;
        return {
          result: {
            domain,
            status: DomainStatus.Unknown,
            checkedAt: new Date().toISOString(),
          },
          consensusStats,
        };
      }
    }
  }

  // Legacy single tertiary path (backward compatibility)
  if (options.tertiaryEndpoints !== undefined && !tertiaryConfig) {
    // This path is for backward compatibility when tertiary is passed via endpoints
    // but not as dual-redundant config. We skip it since the new config uses tertiaryConfig.
    logger.warn({ domain }, 'Legacy tertiary path not implemented — downgraded to Unknown');
    consensusStats.unverifiable = 1;
    return {
      result: {
        domain,
        status: DomainStatus.Unknown,
        checkedAt: new Date().toISOString(),
      },
      consensusStats,
    };
  }

  // Secondary confirmed but we need 2 confirmations and no tertiary
  if (config.requiredConfirmations === 2 && !tertiaryConfig) {
    logger.warn(
      { domain },
      'requiredConfirmations=2 but no tertiary configured — downgraded to Unknown',
    );
    consensusStats.unverifiable = 1;
    return {
      result: {
        domain,
        status: DomainStatus.Unknown,
        checkedAt: new Date().toISOString(),
      },
      consensusStats,
    };
  }

  // Fallback: secondary couldn't confirm and no tertiary rescue possible
  consensusStats.unverifiable = 1;
  return {
    result: {
      domain,
      status: DomainStatus.Unknown,
      checkedAt: new Date().toISOString(),
    },
    consensusStats,
  };
}

/**
 * Bulk consensus check with concurrency control.
 */
export async function runConsensusBulk(
  domains: string[],
  options: ConsensusEngineOptions,
  signal?: AbortSignal,
  checkOptions?: { forceRecheck?: boolean },
  concurrency: number = 50,
): Promise<ConsensusResult[]> {
  const results: ConsensusResult[] = [];

  for (let i = 0; i < domains.length; i += concurrency) {
    if (signal?.aborted) break;
    const batch = domains.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (domain): Promise<ConsensusResult> => {
        try {
          return await runConsensus(domain, options, signal, checkOptions);
        } catch {
          return {
            result: {
              domain,
              status: DomainStatus.Unknown,
              checkedAt: new Date().toISOString(),
            },
            consensusStats: {
              verified: 0,
              disagreed: 0,
              unverifiable: 1,
              degraded: false,
              tertiaryRescued: 0,
            },
          };
        }
      }),
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Periodic runtime re-validation of disjointness using live DNS resolution.
 * Called periodically to catch anycast topology changes.
 */
export async function revalidateDisjointness(
  options: ConsensusEngineOptions,
  timeoutMs: number = 2000,
): Promise<void> {
  const {
    primaryEndpoints,
    secondaryEndpoints,
    tertiaryEndpoints,
    primaryGroups,
    secondaryGroups,
    tertiaryGroups,
  } = options;

  if (!primaryEndpoints || !secondaryEndpoints) return;
  if (!primaryGroups || !secondaryGroups) {
    logger.warn(
      'DNS consensus re-validation skipped: resolver groups not available — cannot perform privacy-mode-compliant re-resolution',
    );
    return;
  }

  try {
    const primaryDetails = (primaryEndpoints as ResolvedEndpoints).endpointDetails;
    const secondaryDetails = (secondaryEndpoints as ResolvedEndpoints).endpointDetails;

    if (primaryDetails.length === 0 || secondaryDetails.length === 0) return;

    // Check primary-secondary overlap
    for (const primary of primaryDetails) {
      if (primary.ips.size === 0 || !primary.hostname) continue;

      for (const secondary of secondaryDetails) {
        if (secondary.ips.size === 0 || !secondary.hostname) continue;

        try {
          const primaryIps = await resolveHostnameViaGroups(
            primaryGroups as DnsResolverGroup[],
            primary.hostname,
            timeoutMs,
          );
          const secondaryIps = await resolveHostnameViaGroups(
            secondaryGroups as DnsResolverGroup[],
            secondary.hostname,
            timeoutMs,
          );

          const overlappingIps = [...primaryIps].filter((ip) => secondaryIps.has(ip));
          if (overlappingIps.length > 0) {
            const maxIps = Math.max(primaryIps.size, secondaryIps.size);
            const overlapRatio = overlappingIps.length / maxIps;

            if (overlapRatio > 0.5) {
              logger.warn(
                {
                  primaryIdentity: primary.identity,
                  secondaryIdentity: secondary.identity,
                  overlappingIps,
                  overlapRatio: overlapRatio.toFixed(2),
                },
                'DNS consensus runtime re-validation: anycast overlap detected — gate may be degraded',
              );
            }
          }
        } catch {
          // Resolution failed, skip this pair
        }
      }
    }

    // Also check tertiary if configured
    if (tertiaryGroups && tertiaryEndpoints) {
      const tertiaryDetails = (tertiaryEndpoints as ResolvedEndpoints).endpointDetails;
      if (tertiaryDetails.length > 0) {
        for (const primary of primaryDetails) {
          if (primary.ips.size === 0 || !primary.hostname) continue;

          for (const tertiary of tertiaryDetails) {
            if (tertiary.ips.size === 0 || !tertiary.hostname) continue;

            try {
              const primaryIps = await resolveHostnameViaGroups(
                primaryGroups as DnsResolverGroup[],
                primary.hostname,
                timeoutMs,
              );
              const tertiaryIps = await resolveHostnameViaGroups(
                tertiaryGroups as DnsResolverGroup[],
                tertiary.hostname,
                timeoutMs,
              );

              const overlappingIps = [...primaryIps].filter((ip) => tertiaryIps.has(ip));
              if (overlappingIps.length > 0) {
                const maxIps = Math.max(primaryIps.size, tertiaryIps.size);
                const overlapRatio = overlappingIps.length / maxIps;

                if (overlapRatio > 0.5) {
                  logger.warn(
                    {
                      primaryIdentity: primary.identity,
                      tertiaryIdentity: tertiary.identity,
                      overlappingIps,
                      overlapRatio: overlapRatio.toFixed(2),
                    },
                    'DNS consensus runtime re-validation: primary-tertiary anycast overlap detected',
                  );
                }
              }
            } catch {
              // Resolution failed, skip
            }
          }
        }

        for (const secondary of secondaryDetails) {
          if (secondary.ips.size === 0 || !secondary.hostname) continue;

          for (const tertiary of tertiaryDetails) {
            if (tertiary.ips.size === 0 || !tertiary.hostname) continue;

            try {
              const secondaryIps = await resolveHostnameViaGroups(
                secondaryGroups as DnsResolverGroup[],
                secondary.hostname,
                timeoutMs,
              );
              const tertiaryIps = await resolveHostnameViaGroups(
                tertiaryGroups as DnsResolverGroup[],
                tertiary.hostname,
                timeoutMs,
              );

              const overlappingIps = [...secondaryIps].filter((ip) => tertiaryIps.has(ip));
              if (overlappingIps.length > 0) {
                const maxIps = Math.max(secondaryIps.size, tertiaryIps.size);
                const overlapRatio = overlappingIps.length / maxIps;

                if (overlapRatio > 0.5) {
                  logger.warn(
                    {
                      secondaryIdentity: secondary.identity,
                      tertiaryIdentity: tertiary.identity,
                      overlappingIps,
                      overlapRatio: overlapRatio.toFixed(2),
                    },
                    'DNS consensus runtime re-validation: secondary-tertiary anycast overlap detected',
                  );
                }
              }
            } catch {
              // Resolution failed, skip
            }
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'DNS consensus re-validation error — continuing with cached validation');
  }
}
