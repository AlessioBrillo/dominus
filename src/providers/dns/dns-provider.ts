import type { DnsCheckResult } from '../../types/domain-status.js';

export interface DnsLookupSpec {
  type: 'native' | 'doh' | 'dot';
  endpoint?: string;
  /** Optional port override for DoT (default: 853). */
  port?: number;
  /** Optional hostname for DoT TLS SNI verification (default: from endpoint). */
  servername?: string;
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
    case 'doh-primary':
      return [
        {
          name: 'multi-doh',
          lookups: DEFAULT_DOH_PROVIDERS.map((p) => ({
            type: 'doh' as const,
            endpoint: p.url,
          })),
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

export interface DnsProvider {
  readonly name: string;
  checkAvailability(domain: string, signal?: AbortSignal): Promise<DnsCheckResult>;
  checkBulk(domains: string[], signal?: AbortSignal): Promise<DnsCheckResult[]>;
  clearCache(): void;
  pruneCache(): number;
}
