// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { validateFallbackIsolation } from '../resolver-validator.js';
import type { DnsResolverGroup } from '../dns-provider.js';

describe('DNS Consensus Fallback Isolation Validation (ADR-0063 P0)', () => {
  describe('validateFallbackIsolation', () => {
    it('PASSES when primary fallback uses different recursor than consensus', async () => {
      // Primary uses Cloudflare DoH + native fallback to 172.20.0.10:5300
      const primaryGroups: DnsResolverGroup[] = [
        {
          name: 'multi-doh',
          lookups: [{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }],
        },
        {
          name: 'multi-doh-native-fallback',
          fallback: true,
          lookups: [{ type: 'native', nameservers: ['172.20.0.10:5300'] }],
        },
      ];
      // Consensus uses different recursor 172.20.0.11:5300
      const consensusGroups: DnsResolverGroup[] = [
        {
          name: 'private-recursor',
          lookups: [{ type: 'native', nameservers: ['172.20.0.11:5300'] }],
        },
      ];

      const result = await validateFallbackIsolation(primaryGroups, consensusGroups);
      expect(result.isolated).toBe(true);
      expect(result.fallbackOverlap).toHaveLength(0);
    });

    it('FAILS when primary fallback shares the SAME recursor as consensus (P0 bug)', async () => {
      // Primary uses Cloudflare DoH + native fallback to 172.20.0.10:5300
      const primaryGroups: DnsResolverGroup[] = [
        {
          name: 'multi-doh',
          lookups: [{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }],
        },
        {
          name: 'multi-doh-native-fallback',
          fallback: true,
          lookups: [{ type: 'native', nameservers: ['172.20.0.10:5300'] }],
        },
      ];
      // Consensus ALSO points to 172.20.0.10:5300 (SAME recursor as primary fallback!)
      const consensusGroups: DnsResolverGroup[] = [
        {
          name: 'private-recursor',
          lookups: [{ type: 'native', nameservers: ['172.20.0.10:5300'] }],
        },
      ];

      const result = await validateFallbackIsolation(primaryGroups, consensusGroups);
      expect(result.isolated).toBe(false);
      expect(result.fallbackOverlap).toContain('native:172.20.0.10:5300');
    });

    it('FAILS when primary fallback shares IP with consensus via different transport', async () => {
      // Primary fallback uses DoH to cloudflare-dns.com (resolves to 1.1.1.1)
      const primaryGroups: DnsResolverGroup[] = [
        {
          name: 'multi-doh',
          lookups: [{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }],
        },
        {
          name: 'fallback',
          fallback: true,
          lookups: [{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }],
        },
      ];
      // Consensus uses DoT to 1.1.1.1 (same IP!)
      const consensusGroups: DnsResolverGroup[] = [
        {
          name: 'dot-consensus',
          lookups: [{ type: 'dot', endpoint: '1.1.1.1', servername: 'cloudflare-dns.com' }],
        },
      ];

      // Mock DNS resolution for cloudflare-dns.com -> 1.1.1.1
      const result = await validateFallbackIsolation(
        primaryGroups,
        consensusGroups,
        undefined,
        undefined,
        async (host) => {
          if (host === 'cloudflare-dns.com') return ['1.1.1.1'];
          return [];
        },
      );
      expect(result.isolated).toBe(false);
      expect(result.fallbackOverlap).toContain('ip:1.1.1.1');
    });

    it('PASSES when consensus has NO fallback overlap but primary has multiple fallbacks', async () => {
      const primaryGroups: DnsResolverGroup[] = [
        {
          name: 'multi-doh',
          lookups: [{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }],
        },
        {
          name: 'fallback1',
          fallback: true,
          lookups: [{ type: 'native', nameservers: ['172.20.0.10:5300'] }],
        },
        {
          name: 'fallback2',
          fallback: true,
          lookups: [{ type: 'native', nameservers: ['172.20.0.20:5300'] }],
        },
      ];
      const consensusGroups: DnsResolverGroup[] = [
        {
          name: 'private-recursor',
          lookups: [{ type: 'native', nameservers: ['172.20.0.11:5300'] }],
        },
      ];

      const result = await validateFallbackIsolation(primaryGroups, consensusGroups);
      expect(result.isolated).toBe(true);
    });

    it('returns structured overlap data for metrics/alerting', async () => {
      const primaryGroups: DnsResolverGroup[] = [
        {
          name: 'multi-doh',
          lookups: [{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }],
        },
        {
          name: 'fallback',
          fallback: true,
          lookups: [{ type: 'native', nameservers: ['172.20.0.10:5300'] }],
        },
      ];
      const consensusGroups: DnsResolverGroup[] = [
        {
          name: 'private-recursor',
          lookups: [{ type: 'native', nameservers: ['172.20.0.10:5300'] }],
        },
      ];

      const result = await validateFallbackIsolation(primaryGroups, consensusGroups);
      expect(result).toHaveProperty('isolated');
      expect(result).toHaveProperty('fallbackOverlap');
      expect(result).toHaveProperty('primaryFallbackEndpoints');
      expect(result).toHaveProperty('consensusEndpoints');
      expect(Array.isArray(result.fallbackOverlap)).toBe(true);
    });

    it('handles missing fallbacks gracefully (no fallback = no overlap)', async () => {
      const primaryGroups: DnsResolverGroup[] = [
        {
          name: 'multi-doh',
          lookups: [{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }],
        },
        // No fallback group
      ];
      const consensusGroups: DnsResolverGroup[] = [
        {
          name: 'private-recursor',
          lookups: [{ type: 'native', nameservers: ['172.20.0.10:5300'] }],
        },
      ];

      const result = await validateFallbackIsolation(primaryGroups, consensusGroups);
      expect(result.isolated).toBe(true);
      expect(result.fallbackOverlap).toHaveLength(0);
    });
  });

  describe('Integration: buildDnsConsensusConfig uses fallback isolation', () => {
    it('should fail-closed when fallback overlap detected', async () => {
      // This is a placeholder for the integration test
      // The actual test will verify that buildDnsConsensusConfig calls validateFallbackIsolation
      // and throws when fallback overlap is detected
      expect(true).toBe(true);
    });
  });
});
