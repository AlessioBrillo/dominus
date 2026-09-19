// SPDX-License-Identifier: AGPL-3.0-only
import type { DnsCheckResult } from '../../types/domain-status.js';

export type { DnsCheckResult } from '../../types/domain-status.js';

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
   * answer. Fallback groups provide a last-resort safety net for the
   * primary resolver (e.g., native resolver fallback when DoH fails).
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
  /**
   * Health check for the DNS provider. Returns detailed result including
   * DNSSEC validation status. Used at startup to validate the resolver is
   * reachable and functional before accepting traffic.
   */
  healthCheck?(): Promise<{ healthy: boolean; dnssecValid: boolean; details: string }>;
}
