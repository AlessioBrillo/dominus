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
  /** Per-lookup nameservers (only for type: 'native'). When set, creates a dedicated Resolver. */
  nameservers?: string[];
}

export interface DnsResolverGroup {
  name: string;
  lookups: DnsLookupSpec[];
}

const DEFAULT_DOH_PROVIDERS: Array<{ name: string; url: string }> = [
  { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'Google', url: 'https://dns.google/dns-query' },
  { name: 'Quad9', url: 'https://dns.quad9.net/dns-query' },
];

const DEFAULT_DOT_PROVIDERS: Array<{ name: string; host: string }> = [
  { name: 'Cloudflare', host: '1.1.1.1' },
  { name: 'Google', host: '8.8.8.8' },
  { name: 'Quad9', host: '9.9.9.9' },
];

export function strategyToResolverGroups(
  strategy: string,
  _defaultDohEndpoint: string,
): DnsResolverGroup[] {
  switch (strategy) {
    case 'doh-only':
      return [
        {
          name: 'multi-doh',
          lookups: DEFAULT_DOH_PROVIDERS.map((p) => ({
            type: 'doh' as const,
            endpoint: p.url,
          })),
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
          lookups: DEFAULT_DOH_PROVIDERS.map((p) => ({
            type: 'doh' as const,
            endpoint: p.url,
          })),
        },
        {
          name: 'multi-doh-native-fallback',
          lookups: [{ type: 'native' as const }],
        },
      ];
    case 'multi-doh-plus-native':
      return [
        {
          name: 'multi-doh',
          lookups: [
            ...DEFAULT_DOH_PROVIDERS.map((p) => ({
              type: 'doh' as const,
              endpoint: p.url,
            })),
            { type: 'native' as const },
          ],
        },
      ];
    case 'dot-only':
      return [
        {
          name: 'multi-dot',
          lookups: DEFAULT_DOT_PROVIDERS.map((p) => ({
            type: 'dot' as const,
            endpoint: p.host,
            servername:
              p.name === 'Cloudflare'
                ? 'cloudflare-dns.com'
                : p.name === 'Google'
                  ? 'dns.google'
                  : 'dns.quad9.net',
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
            servername:
              p.name === 'Cloudflare'
                ? 'cloudflare-dns.com'
                : p.name === 'Google'
                  ? 'dns.google'
                  : 'dns.quad9.net',
          })),
        },
        {
          name: 'multi-doh-fallback',
          lookups: DEFAULT_DOH_PROVIDERS.map((p) => ({
            type: 'doh' as const,
            endpoint: p.url,
          })),
        },
      ];
    case 'native-with-doh-fallback':
      return [
        { name: 'primary', lookups: [{ type: 'native' }] },
        {
          name: 'multi-doh-fallback',
          lookups: DEFAULT_DOH_PROVIDERS.map((p) => ({
            type: 'doh' as const,
            endpoint: p.url,
          })),
        },
      ];
    case 'native':
    default:
      return [{ name: 'default', lookups: [{ type: 'native' }] }];
  }
}

export function getDefaultDohProviders(): Array<{ name: string; url: string }> {
  return DEFAULT_DOH_PROVIDERS;
}

export function getDefaultDotProviders(): Array<{ name: string; host: string }> {
  return DEFAULT_DOT_PROVIDERS;
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
export function collectResolverEndpoints(
  groups: DnsResolverGroup[],
  defaultNameservers?: string[],
): string[] {
  const endpoints = new Set<string>();

  const add = (prefix: string, hostOrIp: string): void => {
    endpoints.add(`${prefix}:${hostOrIp}`);
    if (isIP(hostOrIp) !== 0) endpoints.add(`ip:${hostOrIp}`);
  };

  for (const group of groups) {
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
