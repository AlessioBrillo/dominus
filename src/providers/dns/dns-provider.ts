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
          lookups: DEFAULT_DOH_PROVIDERS.map(dohProviderToSpec),
        },
      ];
    case 'native-with-doh-fallback':
      return [
        { name: 'primary', lookups: [{ type: 'native' }] },
        {
          name: 'multi-doh-fallback',
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
