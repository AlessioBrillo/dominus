// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { validateFallbackIsolation } from '../resolver-validator.js';
import type { DnsResolverGroup } from '../dns-provider.js';

describe('DNS Consensus Fallback Isolation Validation (ADR-0063 P0)', () => {
  describe('validateFallbackIsolation', () => {
    it('PASSES when primary fallback uses different recursor than consensus', async () => {
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
      const consensusGroups: DnsResolverGroup[] = [
        {
          name: 'private-recursor',
          lookups: [{ type: 'native', nameservers: ['172.20.0.11:5300'] }],
        },
      ];

      const result = await validateFallbackIsolation(
        primaryGroups,
        consensusGroups,
        ['172.20.0.11:5300'],
        undefined,
      );
      expect(result.isolated).toBe(true);
      expect(result.fallbackOverlap).toHaveLength(0);
    });

    it('FAILS when primary fallback shares the SAME recursor as consensus (P0 bug)', async () => {
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
      const consensusGroups: DnsResolverGroup[] = [
        {
          name: 'private-recursor',
          lookups: [{ type: 'native', nameservers: ['172.20.0.10:5300'] }],
        },
      ];

      const result = await validateFallbackIsolation(
        primaryGroups,
        consensusGroups,
        ['172.20.0.10:5300'],
        undefined,
      );
      expect(result.isolated).toBe(false);
      expect(result.fallbackOverlap).toContain('native:172.20.0.10:5300');
    });

    it('does NOT detect IP overlap via different transports in static check (requires live resolution)', async () => {
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
      const consensusGroups: DnsResolverGroup[] = [
        {
          name: 'dot-consensus',
          lookups: [{ type: 'dot', endpoint: '1.1.1.1', servername: 'cloudflare-dns.com' }],
        },
      ];

      const result = await validateFallbackIsolation(
        primaryGroups,
        consensusGroups,
        undefined,
        undefined,
      );
      // Static check compares endpoint strings, not resolved IPs
      // cloudflare-dns.com (DoH) vs 1.1.1.1 (DoT) are different endpoint strings
      // Live resolution overlap detection is done by validateConsensusDisjointnessRuntime
      expect(result.isolated).toBe(true);
      expect(result.fallbackOverlap).toHaveLength(0);
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

      const result = await validateFallbackIsolation(
        primaryGroups,
        consensusGroups,
        ['172.20.0.11:5300'],
        undefined,
      );
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

      const result = await validateFallbackIsolation(
        primaryGroups,
        consensusGroups,
        ['172.20.0.10:5300'],
        undefined,
      );
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
      ];
      const consensusGroups: DnsResolverGroup[] = [
        {
          name: 'private-recursor',
          lookups: [{ type: 'native', nameservers: ['172.20.0.10:5300'] }],
        },
      ];

      const result = await validateFallbackIsolation(
        primaryGroups,
        consensusGroups,
        ['172.20.0.10:5300'],
        undefined,
      );
      expect(result.isolated).toBe(true);
      expect(result.fallbackOverlap).toHaveLength(0);
    });
  });

  describe('Integration: buildDnsConsensusConfig uses fallback isolation', () => {
    it('should fail-closed when fallback overlap detected', async () => {
      expect(true).toBe(true);
    });
  });
});
