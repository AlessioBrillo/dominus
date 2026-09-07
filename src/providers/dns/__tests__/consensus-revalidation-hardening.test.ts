// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Resolver } from 'node:dns/promises';
import { revalidateDisjointness, resolveHostnameViaGroups } from '../consensus-engine.js';
import type { DnsResolverGroup, ResolvedEndpoints, ResolvedEndpoint } from '../dns-provider.js';
import type { ConsensusEngineOptions, ConsensusConfig } from '../consensus-engine.js';
import { DomainStatus } from '../../../types/domain-status.js';
import type { DnsCheckResult } from '../../../types/domain-status.js';

// Helper to create resolver groups
function createGroups(
  name: string,
  lookups: Array<{ type: 'native' | 'doh' | 'dot'; endpoint?: string; nameservers?: string[] }>,
): DnsResolverGroup[] {
  return [
    {
      name,
      lookups: lookups.map((l) => ({
        type: l.type,
        ...(l.endpoint !== undefined ? { endpoint: l.endpoint } : {}),
        ...(l.nameservers !== undefined ? { nameservers: l.nameservers } : {}),
      })),
    },
  ];
}

// Minimal ConsensusEngineOptions for revalidation testing (only fields used by revalidateDisjointness)
function createEngineOptions(
  primaryEndpoints: ResolvedEndpoints,
  secondaryEndpoints: ResolvedEndpoints,
  primaryGroups: DnsResolverGroup[],
  secondaryGroups: DnsResolverGroup[],
  config: ConsensusConfig,
  extra?: {
    secondaryEndpoints2?: ResolvedEndpoints;
    secondaryGroups2?: DnsResolverGroup[];
    tertiaryEndpoints?: ResolvedEndpoints;
    tertiaryGroups?: DnsResolverGroup[];
    tertiaryGroups2?: DnsResolverGroup[];
  },
): ConsensusEngineOptions {
  return {
    primary: {
      name: 'mock-primary',
      checkAvailability: async (_domain: string, _signal?: AbortSignal) => ({
        status: DomainStatus.Unknown,
        domain: '',
        checkedAt: new Date().toISOString(),
      }),
      checkBulk: async function (
        _domains: string[],
        _signal?: AbortSignal,
      ): Promise<DnsCheckResult[]> {
        return [];
      },
      clearCache: function (): void {},
      pruneCache: function (): number {
        return 0;
      },
    },
    secondaryProviders: [], // Not used by revalidateDisjointness
    tertiaryProviders: [], // Not used by revalidateDisjointness
    disjointnessValidator: { isDisjoint: () => true }, // Not used by revalidateDisjointness
    config,
    primaryEndpoints,
    secondaryEndpoints,
    secondaryEndpoints2: extra?.secondaryEndpoints2,
    tertiaryEndpoints: extra?.tertiaryEndpoints,
    tertiaryEndpoints2: undefined,
    primaryGroups,
    secondaryGroups,
    secondaryGroups2: extra?.secondaryGroups2,
    tertiaryGroups: extra?.tertiaryGroups,
    tertiaryGroups2: extra?.tertiaryGroups2,
    revalidationIntervalMs: config.revalidationIntervalMs ?? 600_000,
  };
}

describe('DNS Consensus Runtime Revalidation Hardening', () => {
  let originalResolve4: typeof Resolver.prototype.resolve4;
  let originalResolve6: typeof Resolver.prototype.resolve6;

  beforeEach(() => {
    originalResolve4 = Resolver.prototype.resolve4;
    originalResolve6 = Resolver.prototype.resolve6;
  });

  afterEach(() => {
    Resolver.prototype.resolve4 = originalResolve4;
    Resolver.prototype.resolve6 = originalResolve6;
    vi.clearAllMocks();
  });

  describe('revalidateDisjointness - independent resolution of endpoint hostnames', () => {
    it('RESOLVES primary/secondary endpoint HOSTNAMES using system resolver (not pinned recursors)', async () => {
      // Primary uses pinned recursor 127.0.0.1:5300
      // Secondary uses SAME pinned recursor 127.0.0.1:5300 (misconfiguration)
      // The revalidation should resolve the RECURSOR HOSTNAMES using system resolver
      // to detect they point to the same IP, NOT use the pinned recursor itself

      const primaryGroups = createGroups('primary', [
        { type: 'native', nameservers: ['127.0.0.1:5300'] },
      ]);
      const secondaryGroups = createGroups('secondary', [
        { type: 'native', nameservers: ['127.0.0.1:5300'] }, // SAME recursor!
      ]);

      const primaryEndpoints = [
        {
          identity: 'native:127.0.0.1:5300',
          ips: new Set(['127.0.0.1']),
          hostname: '127.0.0.1:5300',
        },
      ];
      const secondaryEndpoints = [
        {
          identity: 'native:127.0.0.1:5300',
          ips: new Set(['127.0.0.1']),
          hostname: '127.0.0.1:5300',
        },
      ];

      // Mock system resolver to return the recursor IP for both
      Resolver.prototype.resolve4 = vi.fn().mockResolvedValue(['127.0.0.1']);
      Resolver.prototype.resolve6 = vi.fn().mockResolvedValue([]);

      const config = {
        requiredConfirmations: 1 as const,
        degradedRatio: 0.5,
        degradedMin: 10,
        revalidationIntervalMs: 600_000,
      };

      const engineOptions = createEngineOptions(
        { endpointDetails: primaryEndpoints } as ResolvedEndpoints,
        { endpointDetails: secondaryEndpoints } as ResolvedEndpoints,
        primaryGroups,
        secondaryGroups,
        config,
      );

      const degraded = await revalidateDisjointness(engineOptions, 2000);

      // Should detect overlap because both recursor hostnames resolve to same IP
      expect(degraded).toBe(true);

      // Verify system resolver was called for the RECURSOR hostnames, not the pinned recursor
      expect(Resolver.prototype.resolve4).toHaveBeenCalledWith('127.0.0.1:5300');
    });

    it('DETECTS anycast overlap when primary and secondary DoH endpoints share IPs', async () => {
      const primaryGroups = createGroups('primary', [
        { type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' },
      ]);
      const secondaryGroups = createGroups('secondary', [
        { type: 'doh', endpoint: 'https://1dot1dot1dot1.cloudflare-dns.com/dns-query' }, // Same operator, different hostname
      ]);

      const primaryEndpoints: ResolvedEndpoint[] = [
        {
          identity: 'doh:cloudflare-dns.com',
          ips: new Set(['1.1.1.1', '1.0.0.1']),
          hostname: 'cloudflare-dns.com',
        },
      ];
      const secondaryEndpoints: ResolvedEndpoint[] = [
        {
          identity: 'doh:1dot1dot1dot1.cloudflare-dns.com',
          ips: new Set(['1.1.1.1', '1.0.0.1']),
          hostname: '1dot1dot1dot1.cloudflare-dns.com',
        },
      ];

      // Mock system resolver to return Cloudflare IPs for both hostnames
      Resolver.prototype.resolve4 = vi
        .fn()
        .mockResolvedValueOnce(['1.1.1.1', '1.0.0.1']) // cloudflare-dns.com
        .mockResolvedValueOnce(['1.1.1.1', '1.0.0.1']); // 1dot1dot1dot1.cloudflare-dns.com
      Resolver.prototype.resolve6 = vi.fn().mockResolvedValue([]);

      const config = {
        requiredConfirmations: 1 as const,
        degradedRatio: 0.5,
        degradedMin: 10,
        revalidationIntervalMs: 600_000,
      };

      const engineOptions = createEngineOptions(
        { endpointDetails: primaryEndpoints } as ResolvedEndpoints,
        { endpointDetails: secondaryEndpoints } as ResolvedEndpoints,
        primaryGroups,
        secondaryGroups,
        config,
      );

      const degraded = await revalidateDisjointness(engineOptions, 2000);

      expect(degraded).toBe(true);
      // Should have resolved both DoH endpoint hostnames
      expect(Resolver.prototype.resolve4).toHaveBeenCalledTimes(2);
    });

    it('PASSES when primary and secondary use genuinely disjoint resolvers', async () => {
      const primaryGroups = createGroups('primary', [
        { type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' },
      ]);
      const secondaryGroups = createGroups('secondary', [
        { type: 'dot', endpoint: '94.140.14.14' }, // AdGuard - different operator
      ]);

      const primaryEndpoints = [
        {
          identity: 'doh:cloudflare-dns.com',
          ips: new Set(['1.1.1.1', '1.0.0.1']),
          hostname: 'cloudflare-dns.com',
        },
      ];
      const secondaryEndpoints = [
        { identity: 'dot:94.140.14.14', ips: new Set(['94.140.14.14']), hostname: '94.140.14.14' },
      ];

      Resolver.prototype.resolve4 = vi
        .fn()
        .mockResolvedValueOnce(['1.1.1.1', '1.0.0.1']) // cloudflare-dns.com
        .mockResolvedValueOnce(['94.140.14.14']); // 94.140.14.14
      Resolver.prototype.resolve6 = vi.fn().mockResolvedValue([]);

      const config = {
        requiredConfirmations: 1 as const,
        degradedRatio: 0.5,
        degradedMin: 10,
        revalidationIntervalMs: 600_000,
      };

      const engineOptions = createEngineOptions(
        { endpointDetails: primaryEndpoints } as ResolvedEndpoints,
        { endpointDetails: secondaryEndpoints } as ResolvedEndpoints,
        primaryGroups,
        secondaryGroups,
        config,
      );

      const degraded = await revalidateDisjointness(engineOptions, 2000);

      expect(degraded).toBe(false);
    });

    it('HANDLES resolution failures gracefully (fail-open for resolution, not for overlap)', async () => {
      const primaryGroups = createGroups('primary', [
        { type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' },
      ]);
      const secondaryGroups = createGroups('secondary', [
        { type: 'dot', endpoint: '94.140.14.14' },
      ]);

      const primaryEndpoints: ResolvedEndpoint[] = [
        {
          identity: 'doh:cloudflare-dns.com',
          ips: new Set(['1.1.1.1']),
          hostname: 'cloudflare-dns.com',
        },
      ];
      const secondaryEndpoints: ResolvedEndpoint[] = [
        { identity: 'dot:94.140.14.14', ips: new Set(['94.140.14.14']), hostname: '94.140.14.14' },
      ];

      // Simulate resolution failure for secondary
      Resolver.prototype.resolve4 = vi
        .fn()
        .mockResolvedValueOnce(['1.1.1.1'])
        .mockRejectedValueOnce(new Error('ENOTFOUND'));
      Resolver.prototype.resolve6 = vi.fn().mockResolvedValue([]);

      const config = {
        requiredConfirmations: 1 as const,
        degradedRatio: 0.5,
        degradedMin: 10,
        revalidationIntervalMs: 600_000,
      };

      const engineOptions = createEngineOptions(
        { endpointDetails: primaryEndpoints } as ResolvedEndpoints,
        { endpointDetails: secondaryEndpoints } as ResolvedEndpoints,
        primaryGroups,
        secondaryGroups,
        config,
      );

      const degraded = await revalidateDisjointness(engineOptions, 2000);

      // Resolution failure should NOT mark as degraded (fail-open for resolution errors)
      // But should log warning
      expect(degraded).toBe(false);
    });

    it('SKIPS fallback groups in revalidation (same as bootstrap)', async () => {
      const primaryGroups: DnsResolverGroup[] = [
        {
          name: 'primary',
          lookups: [{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }],
        },
        {
          name: 'fallback',
          fallback: true,
          lookups: [{ type: 'native', nameservers: ['127.0.0.1:5300'] }], // Same as secondary!
        },
      ];
      const secondaryGroups = createGroups('secondary', [
        { type: 'native', nameservers: ['127.0.0.1:5300'] },
      ]);

      const primaryEndpoints = [
        {
          identity: 'doh:cloudflare-dns.com',
          ips: new Set(['1.1.1.1']),
          hostname: 'cloudflare-dns.com',
        },
        {
          identity: 'native:127.0.0.1:5300',
          ips: new Set(['127.0.0.1']),
          hostname: '127.0.0.1:5300',
        },
      ];
      const secondaryEndpoints = [
        {
          identity: 'native:127.0.0.1:5300',
          ips: new Set(['127.0.0.1']),
          hostname: '127.0.0.1:5300',
        },
      ];

      Resolver.prototype.resolve4 = vi
        .fn()
        .mockResolvedValueOnce(['1.1.1.1'])
        .mockResolvedValueOnce(['127.0.0.1']);
      Resolver.prototype.resolve6 = vi.fn().mockResolvedValue([]);

      const config = {
        requiredConfirmations: 1 as const,
        degradedRatio: 0.5,
        degradedMin: 10,
        revalidationIntervalMs: 600_000,
      };

      const engineOptions = createEngineOptions(
        { endpointDetails: primaryEndpoints } as ResolvedEndpoints,
        { endpointDetails: secondaryEndpoints } as ResolvedEndpoints,
        primaryGroups,
        secondaryGroups,
        config,
      );

      const degraded = await revalidateDisjointness(engineOptions, 2000);

      // Fallback group should be excluded, so only primary DoH vs secondary native compared
      // No overlap between cloudflare-dns.com and 127.0.0.1:5300
      expect(degraded).toBe(false);
    });
  });

  describe('resolveHostnameViaGroups - privacy-mode compliant resolution', () => {
    it('USES pinned nameservers when available for native lookups', async () => {
      const groups = createGroups('test', [{ type: 'native', nameservers: ['127.0.0.1:5300'] }]);

      Resolver.prototype.resolve4 = vi.fn().mockResolvedValue(['192.168.1.1']);
      Resolver.prototype.resolve6 = vi.fn().mockResolvedValue([]);

      const ips = await resolveHostnameViaGroups(groups, 'example.com', 2000);

      expect(ips).toContain('192.168.1.1');
      // Should have used the pinned nameserver resolver
      expect(Resolver.prototype.resolve4).toHaveBeenCalled();
    });

    it('RESOLVES DoH endpoint hostname using system resolver', async () => {
      const groups = createGroups('test', [
        { type: 'doh', endpoint: 'https://dns.google/dns-query' },
      ]);

      Resolver.prototype.resolve4 = vi.fn().mockResolvedValue(['8.8.8.8', '8.8.4.4']);
      Resolver.prototype.resolve6 = vi.fn().mockResolvedValue([]);

      const ips = await resolveHostnameViaGroups(groups, 'dns.google', 2000);

      expect(ips).toContain('8.8.8.8');
      expect(Resolver.prototype.resolve4).toHaveBeenCalledWith('dns.google');
    });

    it('HANDLES DoT endpoint that is already an IP', async () => {
      const groups = createGroups('test', [{ type: 'dot', endpoint: '9.9.9.9' }]);

      // Should not call resolver for IP endpoints
      Resolver.prototype.resolve4 = vi.fn();
      Resolver.prototype.resolve6 = vi.fn();

      const ips = await resolveHostnameViaGroups(groups, '9.9.9.9', 2000);

      expect(ips).toContain('9.9.9.9');
      expect(Resolver.prototype.resolve4).not.toHaveBeenCalled();
    });
  });
});
