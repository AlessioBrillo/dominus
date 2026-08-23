// SPDX-License-Identifier: AGPL-3.0-only
import { isIP } from 'node:net';
import type { DnsCheckResult } from '../../types/domain-status.js';

export interface DnsLookupSpec {
  type: 'native' | 'doh' | 'dot';
  endpoint?: string;
  /** Optional port override for DoT (default: 853). */
  port?: number;
  /** Optional hostname for DoT TLS SNI verification (default: from endpoint). */
  servername?: string;
  /** DoH request format: JSON API (default) or RFC 8484 wire (base64url `dns=` GET). */
  format?: 'json' | 'wire';
  /** Per-lookup nameservers (only for type: 'native'). When set, creates a dedicated Resolver. */
  nameservers?: string[];
}

export interface DnsResolverGroup {
  name: string;
  lookups: DnsLookupSpec[];
  /**
   * Emergency fallback group: only consulted when the main group cannot
   * answer. Fallback legs are excluded from consensus disjointness checks —
   * the 2-of-3 gate must be disjoint from the primary's MAIN opinion, not
   * from its last-resort safety net. A shared fallback is harmless: if the
   * shared resolver is down the fallback returns undefined, which can never
   * manufacture an Available verdict (ADR-0002).
   */
  fallback?: boolean;
}

const DEFAULT_DOH_PROVIDERS: Array<{ name: string; url: string; format?: 'json' | 'wire' }> = [
  // Live-verified JSON API endpoints (2026-08-08). dns.google must be hit
  // on /resolve (the /dns-query path answers 400 to JSON GETs) and
  // dns.quad9.net is RFC 8484 wire-format only (formerly a silent 505 for
  // every JSON query — ADR-0047). Cloudflare answers JSON on /dns-query.
  { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'Google', url: 'https://dns.google/resolve' },
  { name: 'Quad9', url: 'https://dns.quad9.net/dns-query', format: 'wire' },
];

const DEFAULT_DOT_PROVIDERS: Array<{ name: string; host: string }> = [
  { name: 'Cloudflare', host: '1.1.1.1' },
  { name: 'Google', host: '8.8.8.8' },
  { name: 'Quad9', host: '9.9.9.9' },
];

/**
 * Operators the default DoH primary never consults. Used by the
 * 'dot-alternate' consensus strategy: with DNS_CONSENSUS_STRATEGY defaulting
 * to it, the 2-of-3 gate's second opinion is genuinely operator-disjoint
 * from the default 'doh-primary' primary (Cloudflare/Google/Quad9) — the
 * P1 hardening that a same-operator DoH-vs-DoT pairing must not be treated
 * as an independent opinion.
 */
const DEFAULT_DOT_ALTERNATE_PROVIDERS: Array<{ name: string; host: string }> = [
  { name: 'AdGuard', host: '94.140.14.14' },
  { name: 'Mullvad', host: '194.242.2.2' },
  { name: 'NextDNS', host: '45.90.28.2' },
];

/**
 * Operator-disjoint DoH providers used by the 'doh-alternate' strategy.
 * Cisco OpenDNS answers RFC 8484 wire-format GETs (live-verified
 * 2026-08-20); Digital Society (dns.digitale-gesellschaft.ch, live-verified
 * 2026-08-20 through the real wire path) adds a second keyless operator so
 * the group keeps a majority vote and two breaker circuits — a single
 * degraded DoH endpoint can no longer silently remove the tertiary opinion
 * (ADR-0065). Both are independent of the default primary
 * (Cloudflare/Google/Quad9) and consensus (AdGuard/Mullvad/NextDNS) sets,
 * and disjoint from a pinned private recursor — the turnkey tertiary
 * opinion of ADR-0064.
 */
const DEFAULT_DOH_ALTERNATE_PROVIDERS: Array<{
  name: string;
  url: string;
  format?: 'json' | 'wire';
}> = [
  { name: 'OpenDNS', url: 'https://dns.opendns.com/dns-query', format: 'wire' },
  {
    name: 'DigitalSociety',
    url: 'https://dns.digitale-gesellschaft.ch/dns-query',
    format: 'wire',
  },
];

/**
 * Multi-operator DoH primary group — explicit separation from the legacy
 * 'doh-primary' (which carries a native fallback). This group is the
 * primary's MAIN opinion for the 2-of-3 consensus gate: three independent
 * operators (Cloudflare, Google, Quad9) over DoH wire/JSON, no fallback.
 * The fallback is a separate group, so the disjointness check can exclude
 * it and the consensus gate stays independent of the primary's safety net.
 * (ADR-0063, ADR-0064, ADR-0065)
 */
const DEFAULT_DOH_PRIMARY_PROVIDERS: Array<{
  name: string;
  url: string;
  format?: 'json' | 'wire';
}> = [
  { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'Google', url: 'https://dns.google/resolve' },
  { name: 'Quad9', url: 'https://dns.quad9.net/dns-query', format: 'wire' },
];

/**
 * Multi-operator DoT consensus group — operators disjoint from the default
 * DoH primary. AdGuard, Mullvad, NextDNS over DoT. No fallback group —
 * a consensus leg must never fall back into the primary's own resolvers,
 * which would make its opinion a rubber stamp. (ADR-0063)
 */
const DEFAULT_DOT_CONSENSUS_PROVIDERS: Array<{ name: string; host: string }> = [
  { name: 'AdGuard', host: '94.140.14.14' },
  { name: 'Mullvad', host: '194.242.2.2' },
  { name: 'NextDNS', host: '45.90.28.2' },
];

/**
 * Multi-operator DoH tertiary group — operators disjoint from both primary
 * (Cloudflare/Google/Quad9) and consensus (AdGuard/Mullvad/NextDNS).
 * OpenDNS + Digital Society + LibreDNS over DoH wire. Three operators give
 * majority vote resilience (2-of-3) and three breaker circuits — a single
 * degraded endpoint can no longer silently remove the tertiary opinion.
 * (ADR-0064, ADR-0065, ADR-0066)
 */
const DEFAULT_DOH_TERTIARY_PROVIDERS: Array<{
  name: string;
  url: string;
  format?: 'json' | 'wire';
}> = [
  { name: 'OpenDNS', url: 'https://dns.opendns.com/dns-query', format: 'wire' },
  {
    name: 'DigitalSociety',
    url: 'https://dns.digitale-gesellschaft.ch/dns-query',
    format: 'wire',
  },
  {
    name: 'LibreDNS',
    url: 'https://doh.libredns.gr/dns-query',
    format: 'wire',
  },
];

/** TLS SNI servername for each default provider's DoT endpoint. */
const DOT_SERVERNAMES: Readonly<Record<string, string>> = {
  Cloudflare: 'cloudflare-dns.com',
  Google: 'dns.google',
  Quad9: 'dns.quad9.net',
  AdGuard: 'dns.adguard.com',
  Mullvad: 'dns.mullvad.net',
  NextDNS: 'dns.nextdns.io',
};

/** Map a default DoH provider entry to a resolver lookup spec, carrying its
 *  request format (RFC 8484 wire for providers without a JSON API). */
function dohProviderToSpec(p: {
  name: string;
  url: string;
  format?: 'json' | 'wire';
}): DnsLookupSpec {
  return {
    type: 'doh',
    endpoint: p.url,
    ...(p.format !== undefined ? { format: p.format } : {}),
  };
}

export function strategyToResolverGroups(
  strategy: string,
  _defaultDohEndpoint: string,
): DnsResolverGroup[] {
  switch (strategy) {
    case 'doh-only':
      return [
        {
          name: 'multi-doh',
          lookups: DEFAULT_DOH_PROVIDERS.map(dohProviderToSpec),
        },
      ];
    case 'doh-primary':
      // DoH first, native fallback on timeout/error — the documented
      // semantics of the default strategy (config DNS_LOOKUP_STRATEGY).
      // Previously this case fell through to 'doh-only', silently dropping
      // the native fallback for every default install.
      return [
        {
          name: 'multi-doh',
          lookups: DEFAULT_DOH_PROVIDERS.map(dohProviderToSpec),
        },
        {
          name: 'multi-doh-native-fallback',
          fallback: true,
          lookups: [{ type: 'native' as const }],
        },
      ];
    case 'multi-doh-plus-native':
      return [
        {
          name: 'multi-doh',
          lookups: [...DEFAULT_DOH_PROVIDERS.map(dohProviderToSpec), { type: 'native' as const }],
        },
      ];
    case 'dot-only':
      return [
        {
          name: 'multi-dot',
          lookups: DEFAULT_DOT_PROVIDERS.map((p) => ({
            type: 'dot' as const,
            endpoint: p.host,
            servername: DOT_SERVERNAMES[p.name] ?? p.host,
          })),
        },
      ];
    case 'dot-alternate':
      // Consensus-side strategy with operators disjoint from the default DoH
      // primary: AdGuard/Mullvad/NextDNS only. Carries no fallback group — a
      // consensus leg must never fall back into the primary's own resolvers.
      return [
        {
          name: 'multi-dot-alternate',
          lookups: DEFAULT_DOT_ALTERNATE_PROVIDERS.map((p) => ({
            type: 'dot' as const,
            endpoint: p.host,
            servername: DOT_SERVERNAMES[p.name] ?? p.host,
          })),
        },
      ];
    case 'dot-with-doh-fallback':
      return [
        {
          name: 'multi-dot',
          lookups: DEFAULT_DOT_PROVIDERS.map((p) => ({
            type: 'dot' as const,
            endpoint: p.host,
            servername: DOT_SERVERNAMES[p.name] ?? p.host,
          })),
        },
        {
          name: 'multi-doh-fallback',
          fallback: true,
          lookups: DEFAULT_DOH_PROVIDERS.map(dohProviderToSpec),
        },
      ];
    case 'doh-alternate':
      // Operator-disjoint DoH opinion (OpenDNS), used as the turnkey
      // tertiary leg (ADR-0064) or any strategy slot that must not reuse
      // the default primary/consensus operators. Carries no fallback — a
      // tertiary/consensus leg must never fall back into the primary's net.
      return [
        {
          name: 'multi-doh-alternate',
          lookups: DEFAULT_DOH_ALTERNATE_PROVIDERS.map(dohProviderToSpec),
        },
      ];
    case 'native-with-doh-fallback':
      return [
        { name: 'primary', lookups: [{ type: 'native' }] },
        {
          name: 'multi-doh-fallback',
          fallback: true,
          lookups: DEFAULT_DOH_PROVIDERS.map(dohProviderToSpec),
        },
      ];
    // === NEW STRATEGIES (ADR-0066): Multi-operator groups with explicit separation ===
    case 'doh-primary-no-fallback':
      // Primary's MAIN opinion: three independent operators (CF/Google/Quad9)
      // over DoH wire/JSON, NO fallback. The fallback is a separate group
      // so disjointness checks can exclude it (ADR-0063, ADR-0064, ADR-0065).
      return [
        {
          name: 'multi-doh-primary',
          lookups: DEFAULT_DOH_PRIMARY_PROVIDERS.map(dohProviderToSpec),
        },
      ];
    case 'dot-consensus':
      // Consensus leg: operators disjoint from primary (AdGuard/Mullvad/NextDNS)
      // over DoT. No fallback — consensus must never fall back into primary's net.
      return [
        {
          name: 'multi-dot-consensus',
          lookups: DEFAULT_DOT_CONSENSUS_PROVIDERS.map((p) => ({
            type: 'dot' as const,
            endpoint: p.host,
            servername: DOT_SERVERNAMES[p.name] ?? p.host,
          })),
        },
      ];
    case 'doh-tertiary':
      // Tertiary leg: operators disjoint from both primary and consensus
      // (OpenDNS + Digital Society). Two operators = majority vote + 2 breakers.
      return [
        {
          name: 'multi-doh-tertiary',
          lookups: DEFAULT_DOH_TERTIARY_PROVIDERS.map(dohProviderToSpec),
        },
      ];
    case 'native':
    default:
      return [{ name: 'default', lookups: [{ type: 'native' }] }];
  }
}

/**
 * Distinct resolver endpoints a set of resolver groups will issue queries
 * against, used to verify that a DNS 2-of-3 consensus secondary does not
 * reuse the same resolvers as the primary — otherwise its opinion is a
 * rubber stamp. Returns a sorted, deduplicated list of endpoint keys:
 *
 * - `doh:<host>` for DoH lookups (the HTTPS endpoint hostname);
 * - `dot:<host-or-ip>` for DoT lookups (the TLS endpoint);
 * - `native:<ip>` for native lookups with pinned nameservers (per-lookup or
 *   shared); `native:system-resolver` when no nameservers are pinned — the
 *   process/OS resolver is part of the verdict path in that case;
 * - `ip:<address>` additionally for every lookup addressed by a bare IP
 *   (DoT IPs, pinned nameservers, IP-form DoH endpoints), exposing overlap across
 *   transports: the same IP over TLS, UDP and HTTPS is the same resolver.
 */
export interface CollectResolverEndpointsOptions {
  /**
   * Skip groups marked `fallback: true` (emergency fallback legs of a
   * strategy). Used by the consensus disjointness checks: the 2-of-3 gate
   * must be independent of the primary's MAIN opinion only — a shared
   * emergency fallback can never manufacture an Available verdict, and
   * excluding it fixes the documented prod override where the primary's
   * native fallback and the consensus both point at the same private
   * recursor, which used to disable the gate at runtime.
   */
  excludeFallbacks?: boolean;
}

export function collectResolverEndpoints(
  groups: DnsResolverGroup[],
  defaultNameservers?: string[],
  options?: CollectResolverEndpointsOptions,
): string[] {
  const endpoints = new Set<string>();

  const add = (prefix: string, hostOrIp: string): void => {
    endpoints.add(`${prefix}:${hostOrIp}`);
    if (isIP(hostOrIp) !== 0) endpoints.add(`ip:${hostOrIp}`);
  };

  for (const group of groups) {
    if (options?.excludeFallbacks && group.fallback === true) continue;
    for (const lookup of group.lookups) {
      if (lookup.type === 'doh') {
        const host = new URL(lookup.endpoint ?? '').hostname;
        if (host !== '') add('doh', host);
      } else if (lookup.type === 'dot') {
        if (lookup.endpoint !== undefined && lookup.endpoint !== '') {
          add('dot', lookup.endpoint);
        }
      } else {
        const nameservers = lookup.nameservers ?? defaultNameservers;
        if (nameservers !== undefined && nameservers.length > 0) {
          for (const ns of nameservers) add('native', ns);
        } else {
          endpoints.add('native:system-resolver');
        }
      }
    }
  }

  return [...endpoints].sort();
}

/**
 * Result of runtime DNS consensus disjointness validation.
 * Contains structured data for alerting and debugging.
 */
export interface DnsConsensusValidationResult {
  /** Sorted list of primary resolver endpoints (doh:host, dot:host, native:ip, ip:address) */
  primaryEndpoints: string[];
  /** Sorted list of secondary resolver endpoints */
  secondaryEndpoints: string[];
  /** Sorted list of tertiary resolver endpoints (if configured) */
  tertiaryEndpoints?: string[];
  /** Overlaps detected between legs */
  overlaps: {
    /** Endpoints shared between primary and secondary */
    primarySecondary: string[];
    /** Endpoints shared between primary and tertiary */
    primaryTertiary: string[];
    /** Endpoints shared between secondary and tertiary */
    secondaryTertiary: string[];
  };
  /** Whether the consensus topology is valid (no overlaps) */
  isValid: boolean;
  /** Human-readable failure reason when isValid=false */
  failureReason?: string;
}

/**
 * Performs live DNS queries to validate that consensus resolver legs
 * are genuinely operator-disjoint. This catches anycast/IP overlap
 * that static analysis (collectResolverEndpoints) cannot detect.
 *
 * Issues a test query through each resolver leg and compares the
 * observed responder IPs/hostnames.
 *
 * @param primaryGroups - Primary resolver groups (from DNS_LOOKUP_STRATEGY)
 * @param secondaryGroups - Secondary consensus groups (from DNS_CONSENSUS_STRATEGY)
 * @param tertiaryGroups - Optional tertiary groups (from DNS_TERTIARY_STRATEGY)
 * @param timeoutMs - Per-query timeout in ms (default: 2000)
 * @returns Validation result with structured overlap data
 */
export async function validateConsensusDisjointnessRuntime(
  primaryGroups: DnsResolverGroup[],
  secondaryGroups: DnsResolverGroup[],
  tertiaryGroups: DnsResolverGroup[] | undefined,
  timeoutMs: number = 2000,
): Promise<DnsConsensusValidationResult> {
  const primaryEndpoints = await resolveEndpointsLive(primaryGroups, timeoutMs);
  const secondaryEndpoints = await resolveEndpointsLive(secondaryGroups, timeoutMs);
  const tertiaryEndpoints = tertiaryGroups
    ? await resolveEndpointsLive(tertiaryGroups, timeoutMs)
    : [];

  const overlaps = {
    primarySecondary: findOverlaps(primaryEndpoints, secondaryEndpoints),
    primaryTertiary:
      tertiaryEndpoints.length > 0 ? findOverlaps(primaryEndpoints, tertiaryEndpoints) : [],
    secondaryTertiary:
      tertiaryEndpoints.length > 0 ? findOverlaps(secondaryEndpoints, tertiaryEndpoints) : [],
  };

  const allOverlaps = [
    ...overlaps.primarySecondary,
    ...overlaps.primaryTertiary,
    ...overlaps.secondaryTertiary,
  ];

  const result: DnsConsensusValidationResult = {
    primaryEndpoints: [...primaryEndpoints].sort(),
    secondaryEndpoints: [...secondaryEndpoints].sort(),
    overlaps,
    isValid: allOverlaps.length === 0,
  };
  if (allOverlaps.length > 0) {
    result.failureReason =
      `Resolver overlap detected: ${allOverlaps.join(', ')}. ` +
      'Configure disjoint resolver sets (DNS_CONSENSUS_NAMESERVERS, DNS_TERTIARY_NAMESERVERS) ' +
      'or disable consensus (DNS_CONSENSUS_ENABLED=false).';
  }
  if (tertiaryEndpoints.length > 0) {
    result.tertiaryEndpoints = [...tertiaryEndpoints].sort();
  }
  return result;
}

/**
 * Resolves the actual endpoints a resolver group will query by issuing
 * a live test query and extracting the responder identity.
 * For DoH: extracts the HTTPS endpoint hostname.
 * For DoT: extracts the TLS server hostname/IP.
 * For native: extracts the nameserver IPs used.
 */
async function resolveEndpointsLive(
  groups: DnsResolverGroup[],
  timeoutMs: number,
): Promise<string[]> {
  const endpoints = new Set<string>();

  for (const group of groups) {
    if (group.fallback) continue; // Skip fallback groups (same as static analysis)

    for (const lookup of group.lookups) {
      try {
        if (lookup.type === 'doh' && lookup.endpoint) {
          // For DoH, the endpoint hostname is the identity
          const host = new URL(lookup.endpoint).hostname;
          endpoints.add(`doh:${host}`);
          // Also try to resolve the hostname to catch anycast
          try {
            const { default: dns } = await import('node:dns/promises');
            const ips = await Promise.race([
              dns.resolve4(host),
              new Promise<string[]>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), timeoutMs),
              ),
            ]);
            for (const ip of ips) {
              endpoints.add(`ip:${ip}`);
            }
          } catch {
            // Resolution failed, but we still have the hostname
          }
        } else if (lookup.type === 'dot' && lookup.endpoint) {
          // For DoT, the endpoint is the server identity
          endpoints.add(`dot:${lookup.endpoint}`);
          if (isIP(lookup.endpoint) !== 0) {
            endpoints.add(`ip:${lookup.endpoint}`);
          } else {
            try {
              const { default: dns } = await import('node:dns/promises');
              const ips = await Promise.race([
                dns.resolve4(lookup.endpoint),
                new Promise<string[]>((_, reject) =>
                  setTimeout(() => reject(new Error('timeout')), timeoutMs),
                ),
              ]);
              for (const ip of ips) {
                endpoints.add(`ip:${ip}`);
              }
            } catch {
              // Resolution failed
            }
          }
        } else if (lookup.type === 'native') {
          const nameservers = lookup.nameservers;
          if (nameservers && nameservers.length > 0) {
            for (const ns of nameservers) {
              endpoints.add(`native:${ns}`);
              if (isIP(ns) !== 0) endpoints.add(`ip:${ns}`);
            }
          } else {
            endpoints.add('native:system-resolver');
          }
        }
      } catch (err) {
        // If we can't determine the endpoint, include a marker
        endpoints.add(`error:${lookup.type}:${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
  }

  return [...endpoints];
}

/**
 * Finds overlapping endpoints between two endpoint sets.
 * Compares both transport-specific (doh:, dot:, native:) and IP-level (ip:) identifiers.
 */
function findOverlaps(setA: string[], setB: string[]): string[] {
  const setBLookup = new Set(setB);
  return setA.filter((endpoint) => setBLookup.has(endpoint));
}

export interface DnsCheckOptions {
  /** When true, skip the persistent DNS cache and force a live lookup.
   *  The in-memory cache is still consulted for within-run deduplication.
   *  Use for domains that may have recently changed status, such as
   *  closeout/expiring domains in the aftermarket. */
  forceRecheck?: boolean;
  /** When true, signal to the downstream RDAP confirmation stage that
   *  WHOIS enrichment should also bypass its cache for this domain.
   *  Mirrors the DNS forceRecheck for closeout/expiring domains where
   *  a stale WHOIS "Available" would incorrectly gate the verdict. */
  forceWhoisRecheck?: boolean;
}

export interface DnsProvider {
  readonly name: string;
  checkAvailability(
    domain: string,
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult>;
  checkBulk(
    domains: string[],
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult[]>;
  clearCache(): void;
  pruneCache(): number;
  /**
   * Release connection pools (DoT sockets) and other long-lived resources.
   * Optional: implementations without pooled resources may omit it; callers
   * must feature-detect before invoking.
   */
  dispose?(): void;
}
