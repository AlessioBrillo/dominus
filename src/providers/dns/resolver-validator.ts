// SPDX-License-Identifier: AGPL-3.0-only
import { isIP } from 'node:net';
import { getLogger } from '../../logger.js';
import type {
  DnsResolverGroup,
  DnsConsensusValidationResult,
  AnycastOverlapDetail,
  ResolvedEndpoint,
  ResolveEndpointsLiveResult,
  CollectResolverEndpointsOptions,
} from './dns-provider.js';
import { collectResolverEndpoints } from './dns-provider.js';

const logger = getLogger();

/**
 * Validates that a resolver group has at least one usable (non-fallback) lookup.
 * Used for fallback strategy auto-switching (ADR-0063/0065).
 */
export function hasUsableLookups(groups: DnsResolverGroup[]): boolean {
  for (const group of groups) {
    if (group.fallback === true) continue;
    for (const lookup of group.lookups) {
      if (lookup.type === 'native') return true;
      if (lookup.type === 'doh' && lookup.endpoint && lookup.endpoint.trim() !== '') return true;
      if (lookup.type === 'dot' && lookup.endpoint && lookup.endpoint.trim() !== '') return true;
    }
  }
  return false;
}

/**
 * Validates that two strategies are disjoint at the strategy level.
 * This is a quick check before doing the full endpoint validation.
 */
export function validateConsensusStrategyDisjointness(
  consensusEnabled: boolean,
  primaryStrategy: string,
  consensusStrategy: string,
): boolean {
  if (!consensusEnabled) return true;
  // Same strategy name means they could use the same endpoints
  // EXCEPTION: 'native' vs 'native' is allowed in privacy mode (ADR-0065)
  // because independence is determined by pinned nameservers, not strategy name.
  if (primaryStrategy === consensusStrategy && primaryStrategy !== 'native') {
    getLogger().warn(
      { primaryStrategy, consensusStrategy },
      'DNS: primary and consensus strategies are identical — disjointness check will likely fail',
    );
    return false;
  }
  return true;
}

/**
 * Validates resolver groups by probing known domains.
 * Non-fatal on failure — groups fall back to per-domain checks at runtime.
 */
export async function validateResolverGroups(
  provider: { checkAvailability: (domain: string) => Promise<unknown> },
  _options?: { forceRecheck?: boolean },
): Promise<void> {
  const testDomains = ['example.com', 'google.com', 'github.com'];
  for (const domain of testDomains) {
    try {
      await provider.checkAvailability(domain);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      getLogger().warn(
        { err: message, domain },
        'DNS: resolver group validation failed for test domain',
      );
      // Don't throw — let runtime handle it
    }
  }
}

/**
 * Finds overlapping endpoints between two endpoint sets.
 * Compares both transport-specific (doh:, dot:, native:) and IP-level (ip:) identifiers.
 */
export function findOverlaps(setA: string[], setB: string[]): string[] {
  const setBLookup = new Set(setB);
  return setA.filter((endpoint) => setBLookup.has(endpoint));
}

/**
 * Computes anycast overlap ratios between two sets of resolver endpoints.
 * Compares IP sets per resolver identity (hostname) to detect anycast sharing.
 */
export function computeAnycastOverlaps(
  primaryDetails: ResolvedEndpoint[],
  secondaryDetails: ResolvedEndpoint[],
  threshold: number,
): AnycastOverlapDetail[] {
  const overlaps: AnycastOverlapDetail[] = [];

  for (const primary of primaryDetails) {
    if (primary.ips.size === 0) continue;

    for (const secondary of secondaryDetails) {
      if (secondary.ips.size === 0) continue;

      const primaryIps = [...primary.ips];
      const secondaryIps = [...secondary.ips];
      const primaryIpSet = new Set(primaryIps);
      const overlappingIps = secondaryIps.filter((ip) => primaryIpSet.has(ip));

      if (overlappingIps.length === 0) continue;

      const maxIps = Math.max(primaryIps.length, secondaryIps.length);
      const overlapRatio = overlappingIps.length / maxIps;

      overlaps.push({
        primaryIdentity: primary.identity,
        secondaryIdentity: secondary.identity,
        primaryIps,
        secondaryIps,
        overlappingIps,
        overlapRatio,
        exceedsThreshold: overlapRatio > threshold,
      });
    }
  }

  return overlaps;
}

/** Well-known operator hints for endpoint identity -> operator mapping */
export const OPERATOR_HINTS: Readonly<Record<string, string>> = {
  'doh:cloudflare-dns.com': 'cloudflare',
  'doh:one.one.one.one': 'cloudflare',
  'doh:dns.google': 'google',
  'doh:dns.google.com': 'google',
  'doh:dns.quad9.net': 'quad9',
  'doh:dns.adguard.com': 'adguard',
  'doh:dns.mullvad.net': 'mullvad',
  'doh:dns.opendns.com': 'opendns',
  'doh:dns.digitale-gesellschaft.ch': 'digitale-gesellschaft',
  'doh:doh.libredns.gr': 'libredns',
  'dot:1.1.1.1': 'cloudflare',
  'dot:1.0.0.1': 'cloudflare',
  'dot:8.8.8.8': 'google',
  'dot:8.8.4.4': 'google',
  'dot:9.9.9.9': 'quad9',
  'dot:149.112.112.112': 'quad9',
  'dot:94.140.14.14': 'adguard',
  'dot:94.140.15.15': 'adguard',
  'dot:194.242.2.2': 'mullvad',
  'dot:193.138.218.74': 'mullvad',
  'dot:45.90.28.2': 'nextdns',
  'dot:45.90.30.2': 'nextdns',
  'native:1.1.1.1': 'cloudflare',
  'native:1.0.0.1': 'cloudflare',
  'native:8.8.8.8': 'google',
  'native:8.8.4.4': 'google',
  'native:9.9.9.9': 'quad9',
  'native:149.112.112.112': 'quad9',
  'native:94.140.14.14': 'adguard',
  'native:94.140.15.15': 'adguard',
  'native:194.242.2.2': 'mullvad',
  'native:193.138.218.74': 'mullvad',
  'native:45.90.28.2': 'nextdns',
  'native:45.90.30.2': 'nextdns',
  'ip:1.1.1.1': 'cloudflare',
  'ip:1.0.0.1': 'cloudflare',
  'ip:162.159.36.1': 'cloudflare',
  'ip:162.159.46.1': 'cloudflare',
  'ip:8.8.8.8': 'google',
  'ip:8.8.4.4': 'google',
  'ip:9.9.9.9': 'quad9',
  'ip:149.112.112.112': 'quad9',
  'ip:94.140.14.14': 'adguard',
  'ip:94.140.15.15': 'adguard',
  'ip:194.242.2.2': 'mullvad',
  'ip:193.138.218.74': 'mullvad',
  'ip:45.90.28.2': 'nextdns',
  'ip:45.90.30.2': 'nextdns',
  'ip:208.67.222.222': 'opendns',
  'ip:208.67.220.220': 'opendns',
  'ip:185.95.218.42': 'digitale-gesellschaft',
  'ip:185.95.218.43': 'digitale-gesellschaft',
  'ip:2a05:fc84::42': 'digitale-gesellschaft',
  'ip:2a05:fc84::43': 'digitale-gesellschaft',
  'ip:116.202.176.26': 'libredns',
  'ip:116.202.176.27': 'libredns',
  'ip:2a01:4f8:1c0c:4c5f::2': 'libredns',
  'ip:2a01:4f8:1c0c:4c5f::3': 'libredns',
};

export interface DisjointnessReport {
  ok: boolean;
  overlapEndpoints: string[];
  overlapOperators: string[];
  resolutionPartial: boolean;
  primaryEndpoints: string[];
  secondaryEndpoints: string[];
}

export interface RuntimeConsensusReport {
  ok: boolean;
  overlapIPs: string[];
  overlapOperators: string[];
  partial: boolean;
  runtimeDegraded: boolean;
  reason?: string;
}

export type RuntimeValidationMode = 'strict' | 'permissive';

export interface FallbackIsolationReport {
  isolated: boolean;
  fallbackOverlap: string[];
  primaryFallbackEndpoints: string[];
  consensusEndpoints: string[];
  singleRecursorMode: boolean;
  degradedReason?: string;
}

/**
 * Validates static disjointness between two resolver group sets (bootstrap-time).
 * Checks hostname-level and operator-level overlap. Excludes fallback groups.
 * Returns a report with ok=false if any overlap detected.
 */
export async function validateConsensusDisjointness(
  primaryGroups: DnsResolverGroup[],
  primaryNameservers: string[] | undefined,
  secondaryGroups: DnsResolverGroup[],
  secondaryNameservers: string[] | undefined,
  options?: CollectResolverEndpointsOptions & {
    onResolutionPartial?: () => void;
  },
): Promise<DisjointnessReport> {
  const primaryEndpoints = collectResolverEndpoints(primaryGroups, primaryNameservers, {
    excludeFallbacks: options?.excludeFallbacks ?? true,
  });
  const secondaryEndpoints = collectResolverEndpoints(secondaryGroups, secondaryNameservers, {
    excludeFallbacks: options?.excludeFallbacks ?? true,
  });

  const overlapEndpoints = primaryEndpoints.filter((ep) => secondaryEndpoints.includes(ep));

  // Operator-level overlap detection
  const primaryOperators = new Set<string>();
  const secondaryOperators = new Set<string>();

  for (const ep of primaryEndpoints) {
    const op = OPERATOR_HINTS[ep];
    if (op) primaryOperators.add(op);
  }
  for (const ep of secondaryEndpoints) {
    const op = OPERATOR_HINTS[ep];
    if (op) secondaryOperators.add(op);
  }

  const overlapOperators = [...primaryOperators].filter((op) => secondaryOperators.has(op));

  const ok = overlapEndpoints.length === 0 && overlapOperators.length === 0;

  if (!ok) {
    logger.warn(
      { overlapEndpoints, overlapOperators, primaryEndpoints, secondaryEndpoints },
      'DNS: static consensus disjointness check FAILED',
    );
  }

  return {
    ok,
    overlapEndpoints,
    overlapOperators,
    resolutionPartial: false, // Static check doesn't do resolution
    primaryEndpoints,
    secondaryEndpoints,
  };
}

/**
 * Validates that the consensus/tertiary resolver set does not overlap with
 * the primary's FALLBACK (emergency) recursor. This prevents the consensus
 * from being a rubber stamp of the primary's last-resort resolver (ADR-0063).
 */
export async function validateFallbackIsolation(
  primaryGroups: DnsResolverGroup[],
  consensusGroups: DnsResolverGroup[],
  consensusNameservers: string[] | undefined,
  primaryNameservers: string[] | undefined,
): Promise<FallbackIsolationReport> {
  // Extract primary's FALLBACK endpoints only
  const primaryFallbackEndpoints = collectResolverEndpoints(primaryGroups, primaryNameservers, {
    excludeFallbacks: false,
  }).filter((ep) => {
    // Only keep endpoints from fallback groups
    for (const group of primaryGroups) {
      if (group.fallback === true) {
        for (const lookup of group.lookups) {
          if (lookup.type === 'native') {
            if (consensusNameservers) {
              for (const ns of consensusNameservers) {
                if (ep === `native:${ns}` || ep === `ip:${ns}`) return true;
              }
            }
            if (ep === 'native:system-resolver') return true;
          } else if (lookup.type === 'doh' && lookup.endpoint) {
            const host = new URL(lookup.endpoint).hostname;
            if (ep === `doh:${host}`) return true;
          } else if (lookup.type === 'dot' && lookup.endpoint) {
            if (ep === `dot:${lookup.endpoint}`) return true;
          }
        }
      }
    }
    return false;
  });

  // Consensus endpoints (non-fallback only)
  const consensusEndpoints = collectResolverEndpoints(consensusGroups, consensusNameservers, {
    excludeFallbacks: true,
  });

  // Check overlap between primary fallback and consensus
  const fallbackOverlap = primaryFallbackEndpoints.filter((ep) => consensusEndpoints.includes(ep));

  // Single recursor mode: primary has no nameservers (uses system) AND
  // consensus uses the same system resolver (or same pinned nameservers)
  const singleRecursorMode =
    (primaryNameservers === undefined || primaryNameservers.length === 0) &&
    (consensusNameservers === undefined || consensusNameservers.length === 0) &&
    primaryFallbackEndpoints.includes('native:system-resolver') &&
    consensusEndpoints.includes('native:system-resolver');

  const isolated = fallbackOverlap.length === 0 && !singleRecursorMode;

  if (!isolated) {
    const reason = singleRecursorMode
      ? 'Single recursor mode: primary fallback and consensus both use system resolver'
      : `Fallback overlap: ${fallbackOverlap.join(', ')}`;
    logger.warn(
      {
        fallbackOverlap,
        primaryFallbackEndpoints,
        consensusEndpoints,
        singleRecursorMode,
      },
      `DNS: fallback isolation check FAILED — ${reason}`,
    );
    return {
      isolated: false,
      fallbackOverlap,
      primaryFallbackEndpoints,
      consensusEndpoints,
      singleRecursorMode,
      degradedReason: reason,
    };
  }

  return {
    isolated: true,
    fallbackOverlap: [],
    primaryFallbackEndpoints,
    consensusEndpoints,
    singleRecursorMode: false,
  };
}

/**
 * Validates runtime disjointness by performing live DNS queries through each
 * resolver leg and comparing resolved IP sets (anycast-aware).
 * This catches IP overlap that hostname/operator checks cannot detect.
 */
export async function validateConsensusDisjointnessRuntime(
  primaryGroups: DnsResolverGroup[],
  secondaryGroups: DnsResolverGroup[],
  tertiaryGroups: DnsResolverGroup[] | undefined,
  timeoutMs: number = 2000,
  anycastOverlapThreshold: number = 0.5,
  options?: {
    failOpenOnResolutionError?: boolean;
    allowSingleRecursorInPrivacyMode?: boolean;
  },
): Promise<DnsConsensusValidationResult> {
  const failOpen = options?.failOpenOnResolutionError ?? false;
  const allowSingleRecursor = options?.allowSingleRecursorInPrivacyMode ?? false;

  const [primaryResult, secondaryResult, tertiaryResult] = await Promise.all([
    resolveEndpointsLiveWithAnycast(primaryGroups, timeoutMs).catch((err) => {
      if (!failOpen) throw err;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Primary resolution failed — failing open',
      );
      return { flatEndpoints: [], endpointDetails: [] } as ResolveEndpointsLiveResult;
    }),
    resolveEndpointsLiveWithAnycast(secondaryGroups, timeoutMs).catch((err) => {
      if (!failOpen) throw err;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Secondary resolution failed — failing open',
      );
      return { flatEndpoints: [], endpointDetails: [] } as ResolveEndpointsLiveResult;
    }),
    tertiaryGroups
      ? resolveEndpointsLiveWithAnycast(tertiaryGroups, timeoutMs).catch((err) => {
          if (!failOpen) throw err;
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'Tertiary resolution failed — failing open',
          );
          return { flatEndpoints: [], endpointDetails: [] } as ResolveEndpointsLiveResult;
        })
      : Promise.resolve({ flatEndpoints: [], endpointDetails: [] } as ResolveEndpointsLiveResult),
  ]);

  // Legacy flat endpoint overlaps
  const overlaps = {
    primarySecondary: findOverlaps(primaryResult.flatEndpoints, secondaryResult.flatEndpoints),
    primaryTertiary:
      tertiaryResult.flatEndpoints.length > 0
        ? findOverlaps(primaryResult.flatEndpoints, tertiaryResult.flatEndpoints)
        : [],
    secondaryTertiary:
      tertiaryResult.flatEndpoints.length > 0
        ? findOverlaps(secondaryResult.flatEndpoints, tertiaryResult.flatEndpoints)
        : [],
  };

  // Anycast-aware overlap analysis
  const anycastOverlaps = {
    primarySecondary: computeAnycastOverlaps(
      primaryResult.endpointDetails,
      secondaryResult.endpointDetails,
      anycastOverlapThreshold,
    ),
    primaryTertiary:
      tertiaryResult.endpointDetails.length > 0
        ? computeAnycastOverlaps(
            primaryResult.endpointDetails,
            tertiaryResult.endpointDetails,
            anycastOverlapThreshold,
          )
        : [],
    secondaryTertiary:
      tertiaryResult.endpointDetails.length > 0
        ? computeAnycastOverlaps(
            secondaryResult.endpointDetails,
            tertiaryResult.endpointDetails,
            anycastOverlapThreshold,
          )
        : [],
  };

  // Check if any anycast overlap exceeds threshold
  const anycastDegraded = [
    ...anycastOverlaps.primarySecondary,
    ...anycastOverlaps.primaryTertiary,
    ...anycastOverlaps.secondaryTertiary,
  ].some((o) => o.exceedsThreshold);

  // Single recursor check (privacy mode): if both primary and secondary
  // resolve to the same single IP set, allow it if explicitly permitted
  let singleRecursorAllowed = false;
  if (allowSingleRecursor) {
    const primaryIps = new Set<string>();
    const secondaryIps = new Set<string>();
    for (const d of primaryResult.endpointDetails) for (const ip of d.ips) primaryIps.add(ip);
    for (const d of secondaryResult.endpointDetails) for (const ip of d.ips) secondaryIps.add(ip);
    if (primaryIps.size > 0 && primaryIps.size === secondaryIps.size) {
      let allMatch = true;
      for (const ip of primaryIps)
        if (!secondaryIps.has(ip)) {
          allMatch = false;
          break;
        }
      if (allMatch) singleRecursorAllowed = true;
    }
  }

  const allOverlaps = [
    ...overlaps.primarySecondary,
    ...overlaps.primaryTertiary,
    ...overlaps.secondaryTertiary,
  ];

  const hasStaticOverlaps = allOverlaps.length > 0;
  const hasAnycastDegraded = anycastDegraded && !singleRecursorAllowed;

  const isValid = !hasStaticOverlaps && !hasAnycastDegraded;

  let failureReason: string | undefined;
  if (hasStaticOverlaps) {
    failureReason = `Resolver overlap detected: ${allOverlaps.join(', ')}. Configure disjoint resolver sets or disable consensus.`;
  } else if (hasAnycastDegraded) {
    const exceedingPairs = [
      ...anycastOverlaps.primarySecondary,
      ...anycastOverlaps.primaryTertiary,
      ...anycastOverlaps.secondaryTertiary,
    ].filter((o) => o.exceedsThreshold);
    failureReason =
      `Anycast overlap exceeds threshold (${anycastOverlapThreshold}): ` +
      exceedingPairs
        .map(
          (o) =>
            `${o.primaryIdentity} <-> ${o.secondaryIdentity} (${(o.overlapRatio * 100).toFixed(1)}% overlap: ${o.overlappingIps.join(', ')})`,
        )
        .join('; ');
  }

  const tertiaryEndpoints =
    tertiaryResult.flatEndpoints.length > 0 ? [...tertiaryResult.flatEndpoints].sort() : undefined;

  const result: DnsConsensusValidationResult = {
    primaryEndpoints: [...primaryResult.flatEndpoints].sort(),
    secondaryEndpoints: [...secondaryResult.flatEndpoints].sort(),
    overlaps,
    anycastOverlaps,
    isValid,
    anycastDegraded: hasAnycastDegraded,
  };

  if (tertiaryEndpoints !== undefined) {
    result.tertiaryEndpoints = tertiaryEndpoints;
  }

  if (failureReason !== undefined) {
    result.failureReason = failureReason;
  }

  return result;
}

/**
 * Performs live DNS resolution of endpoint hostnames to detect anycast IP overlap.
 * Returns structured data mapping each resolver identity to its resolved IP set.
 */
export async function resolveEndpointsLiveWithAnycast(
  groups: DnsResolverGroup[],
  timeoutMs: number,
): Promise<ResolveEndpointsLiveResult> {
  const flatEndpoints = new Set<string>();
  const endpointDetails: ResolvedEndpoint[] = [];
  const hostnameToDetails = new Map<string, ResolvedEndpoint>();

  for (const group of groups) {
    if (group.fallback) continue;

    for (const lookup of group.lookups) {
      try {
        if (lookup.type === 'doh' && lookup.endpoint) {
          const host = new URL(lookup.endpoint).hostname;
          const identity = `doh:${host}`;
          flatEndpoints.add(identity);

          let details = hostnameToDetails.get(host);
          if (!details) {
            details = { identity, ips: new Set(), hostname: host };
            hostnameToDetails.set(host, details);
            endpointDetails.push(details);
          }

          const { default: dns } = await import('node:dns/promises');
          const [aRecords, aaaaRecords] = await Promise.allSettled([
            Promise.race([
              dns.resolve4(host),
              new Promise<string[]>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), timeoutMs),
              ),
            ]),
            Promise.race([
              dns.resolve6(host),
              new Promise<string[]>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), timeoutMs),
              ),
            ]),
          ]);

          if (aRecords.status === 'fulfilled') {
            for (const ip of aRecords.value) {
              details.ips.add(ip);
              flatEndpoints.add(`ip:${ip}`);
            }
          }
          if (aaaaRecords.status === 'fulfilled') {
            for (const ip of aaaaRecords.value) {
              details.ips.add(ip);
              flatEndpoints.add(`ip:${ip}`);
            }
          }
        } else if (lookup.type === 'dot' && lookup.endpoint) {
          const identity = `dot:${lookup.endpoint}`;
          flatEndpoints.add(identity);

          let details = hostnameToDetails.get(lookup.endpoint);
          if (!details) {
            details = { identity, ips: new Set(), hostname: lookup.endpoint };
            hostnameToDetails.set(lookup.endpoint, details);
            endpointDetails.push(details);
          }

          if (isIP(lookup.endpoint) !== 0) {
            details.ips.add(lookup.endpoint);
            flatEndpoints.add(`ip:${lookup.endpoint}`);
          } else {
            const { default: dns } = await import('node:dns/promises');
            const [aRecords, aaaaRecords] = await Promise.allSettled([
              Promise.race([
                dns.resolve4(lookup.endpoint),
                new Promise<string[]>((_, reject) =>
                  setTimeout(() => reject(new Error('timeout')), timeoutMs),
                ),
              ]),
              Promise.race([
                dns.resolve6(lookup.endpoint),
                new Promise<string[]>((_, reject) =>
                  setTimeout(() => reject(new Error('timeout')), timeoutMs),
                ),
              ]),
            ]);

            if (aRecords.status === 'fulfilled') {
              for (const ip of aRecords.value) {
                details.ips.add(ip);
                flatEndpoints.add(`ip:${ip}`);
              }
            }
            if (aaaaRecords.status === 'fulfilled') {
              for (const ip of aaaaRecords.value) {
                details.ips.add(ip);
                flatEndpoints.add(`ip:${ip}`);
              }
            }
          }
        } else if (lookup.type === 'native') {
          const nameservers = lookup.nameservers;
          if (nameservers && nameservers.length > 0) {
            for (const ns of nameservers) {
              const identity = `native:${ns}`;
              flatEndpoints.add(identity);
              if (isIP(ns) !== 0) {
                flatEndpoints.add(`ip:${ns}`);
                let details = hostnameToDetails.get(ns);
                if (!details) {
                  details = { identity, ips: new Set([ns]), hostname: ns };
                  hostnameToDetails.set(ns, details);
                  endpointDetails.push(details);
                } else {
                  details.ips.add(ns);
                }
              }
            }
          } else {
            flatEndpoints.add('native:system-resolver');
            const details: ResolvedEndpoint = {
              identity: 'native:system-resolver',
              ips: new Set(),
            };
            endpointDetails.push(details);
          }
        }
      } catch (err) {
        const errorMarker = `error:${lookup.type}:${err instanceof Error ? err.message : 'unknown'}`;
        flatEndpoints.add(errorMarker);
        endpointDetails.push({
          identity: errorMarker,
          ips: new Set(),
        });
      }
    }
  }

  return {
    flatEndpoints: [...flatEndpoints],
    endpointDetails,
  };
}

/**
 * Validates the runtime consensus gate with proper error handling for
 * strict/permissive modes (ADR-0066).
 */
export async function validateRuntimeConsensusDisjointness(
  primaryProvider: { checkAvailability: (domain: string) => Promise<unknown> },
  secondaryProvider: { checkAvailability: (domain: string) => Promise<unknown> },
  tertiaryProviders: { checkAvailability: (domain: string) => Promise<unknown> }[] | undefined,
  mode: RuntimeValidationMode,
): Promise<RuntimeConsensusReport> {
  const testDomain = 'example.com';

  try {
    // Probe primary
    await primaryProvider.checkAvailability(testDomain);

    // Probe secondary
    await secondaryProvider.checkAvailability(testDomain);

    // Probe tertiary if configured
    if (tertiaryProviders && tertiaryProviders.length > 0) {
      for (const tertiary of tertiaryProviders) {
        await tertiary.checkAvailability(testDomain);
      }
    }

    return {
      ok: true,
      overlapIPs: [],
      overlapOperators: [],
      partial: false,
      runtimeDegraded: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes('timeout') || message.includes('ETIMEOUT');
    const isNetworkError = message.includes('ENOTFOUND') || message.includes('ECONNREFUSED');

    if (mode === 'permissive' && (isTimeout || isNetworkError)) {
      logger.warn(
        { err: message, mode },
        'DNS: runtime consensus validation failed (transient) — continuing in permissive mode',
      );
      return {
        ok: true,
        overlapIPs: [],
        overlapOperators: [],
        partial: true,
        runtimeDegraded: false,
        reason: 'transient failure in permissive mode',
      };
    }

    logger.error({ err: message, mode }, 'DNS: runtime consensus validation FAILED');
    return {
      ok: false,
      overlapIPs: [],
      overlapOperators: [],
      partial: false,
      runtimeDegraded: true,
      reason: message,
    };
  }
}
