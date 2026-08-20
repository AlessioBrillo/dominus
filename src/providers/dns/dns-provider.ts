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
    case 'native-with-doh-fallback':
      return [
        { name: 'primary', lookups: [{ type: 'native' }] },
        {
          name: 'multi-doh-fallback',
          fallback: true,
          lookups: DEFAULT_DOH_PROVIDERS.map(dohProviderToSpec),
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

export interface DnsCheckOptions {
  /** When true, skip the persistent DNS cache and force a live lookup.
   *  The in-memory cache is still consulted for within-run deduplication.
   *  Use for domains that may have recently changed status, such as
   *  closeout/expiring domains in the aftermarket. */
  forceRecheck?: boolean;
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
