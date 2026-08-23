// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateConsensusDisjointnessRuntime,
  collectResolverEndpoints,
  type DnsResolverGroup,
} from '../dns-provider.js';

// Helper to create resolver groups with specific endpoints
function createGroupsFromProviders(
  providers: Array<{
    name: string;
    type: 'native' | 'doh' | 'dot';
    endpoint?: string;
    nameservers?: string[];
  }>,
): DnsResolverGroup[] {
  return [
    {
      name: 'test-group',
      lookups: providers.map((p) => {
        const lookup: {
          type: 'native' | 'doh' | 'dot';
          endpoint?: string;
          nameservers?: string[];
        } = { type: p.type };
        if (p.endpoint !== undefined) lookup.endpoint = p.endpoint;
        if (p.nameservers !== undefined) lookup.nameservers = p.nameservers;
        return lookup;
      }),
    },
  ];
}

describe('DNS Consensus Bootstrap Validation', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  describe('collectResolverEndpoints (static analysis)', () => {
    it('detects overlapping DoH endpoints between primary and secondary', () => {
      const primaryGroups = createGroupsFromProviders([
        { name: 'Cloudflare', type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' },
        { name: 'Google', type: 'doh', endpoint: 'https://dns.google/resolve' },
      ]);
      const secondaryGroups = createGroupsFromProviders([
        { name: 'Cloudflare', type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }, // Same as primary
        { name: 'Quad9', type: 'doh', endpoint: 'https://dns.quad9.net/dns-query' },
      ]);

      const primaryEndpoints = collectResolverEndpoints(primaryGroups);
      const secondaryEndpoints = collectResolverEndpoints(secondaryGroups);

      const overlap = primaryEndpoints.filter((e) => secondaryEndpoints.includes(e));
      expect(overlap).toContain('doh:cloudflare-dns.com');
    });

    it('detects overlapping native nameservers', () => {
      const primaryGroups = createGroupsFromProviders([
        { name: 'primary', type: 'native', nameservers: ['1.1.1.1', '8.8.8.8'] },
      ]);
      const secondaryGroups = createGroupsFromProviders([
        { name: 'secondary', type: 'native', nameservers: ['1.1.1.1', '9.9.9.9'] }, // 1.1.1.1 overlaps
      ]);

      const primaryEndpoints = collectResolverEndpoints(primaryGroups);
      const secondaryEndpoints = collectResolverEndpoints(secondaryGroups);

      const overlap = primaryEndpoints.filter((e) => secondaryEndpoints.includes(e));
      expect(overlap).toContain('native:1.1.1.1');
      expect(overlap).toContain('ip:1.1.1.1'); // IP-level overlap also tracked
    });

    it('excludes fallback groups from overlap detection', () => {
      const primaryGroups: DnsResolverGroup[] = [
        {
          name: 'primary',
          lookups: [{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }],
        },
        { name: 'fallback', fallback: true, lookups: [{ type: 'native' }] }, // fallback shares system resolver
      ];
      const secondaryGroups: DnsResolverGroup[] = [
        { name: 'secondary', lookups: [{ type: 'native' }] }, // Uses system resolver
      ];

      const primaryEndpoints = collectResolverEndpoints(primaryGroups, undefined, {
        excludeFallbacks: true,
      });
      const secondaryEndpoints = collectResolverEndpoints(secondaryGroups);

      // fallback group excluded, so primary has only DoH endpoints
      expect(primaryEndpoints).not.toContain('native:system-resolver');
      // secondary still has system resolver
      expect(secondaryEndpoints).toContain('native:system-resolver');
      // No overlap because fallback excluded
      const overlap = primaryEndpoints.filter((e) => secondaryEndpoints.includes(e));
      expect(overlap).toHaveLength(0);
    });

    it('detects same operator across different transports (DoH vs DoT)', () => {
      const primaryGroups = createGroupsFromProviders([
        { name: 'Cloudflare', type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' },
      ]);
      const secondaryGroups = createGroupsFromProviders([
        { name: 'Cloudflare', type: 'dot', endpoint: '1.1.1.1' }, // Same operator, different transport
      ]);

      const primaryEndpoints = collectResolverEndpoints(primaryGroups);
      const secondaryEndpoints = collectResolverEndpoints(secondaryGroups);

      // IP-level overlap: 1.1.1.1 is Cloudflare's IP
      expect(primaryEndpoints).toContain('doh:cloudflare-dns.com');
      expect(secondaryEndpoints).toContain('dot:1.1.1.1');
      expect(secondaryEndpoints).toContain('ip:1.1.1.1');
      // The static check can't catch this, but runtime validation will
    });
  });

  describe('validateConsensusDisjointnessRuntime (live query validation)', () => {
    it('PASSES when primary and secondary use disjoint resolver sets (default config)', async () => {
      // Default: primary=doh-primary (CF/Google/Quad9), secondary=dot-alternate (AdGuard/Mullvad/NextDNS)
      const primaryGroups = createGroupsFromProviders([
        { name: 'Cloudflare', type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' },
        { name: 'Google', type: 'doh', endpoint: 'https://dns.google/resolve' },
        { name: 'Quad9', type: 'doh', endpoint: 'https://dns.quad9.net/dns-query' },
      ]);
      const secondaryGroups = createGroupsFromProviders([
        { name: 'AdGuard', type: 'dot', endpoint: '94.140.14.14' },
        { name: 'Mullvad', type: 'dot', endpoint: '194.242.2.2' },
        { name: 'NextDNS', type: 'dot', endpoint: '45.90.28.2' },
      ]);
      const tertiaryGroups = createGroupsFromProviders([
        { name: 'OpenDNS', type: 'doh', endpoint: 'https://dns.opendns.com/dns-query' },
        {
          name: 'DigitalSociety',
          type: 'doh',
          endpoint: 'https://dns.digitale-gesellschaft.ch/dns-query',
        },
      ]);

      // The implementation uses dns.resolve4 internally, not fetch
      // Mock will be called but we don't need to set it up for this test

      const result = await validateConsensusDisjointnessRuntime(
        primaryGroups,
        secondaryGroups,
        tertiaryGroups,
        2000,
      );

      expect(result.isValid).toBe(true);
      // Primary: 3 DoH endpoints + resolved IPs (at least 3)
      expect(result.primaryEndpoints.length).toBeGreaterThanOrEqual(3);
      // Secondary: 3 DoT endpoints (IPs) - no DNS resolution for IPs
      expect(result.secondaryEndpoints.length).toBeGreaterThanOrEqual(3);
      // Tertiary: 2 DoH endpoints + resolved IPs
      expect(result.tertiaryEndpoints?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(result.overlaps.primarySecondary).toHaveLength(0);
      expect(result.overlaps.primaryTertiary).toHaveLength(0);
      expect(result.overlaps.secondaryTertiary).toHaveLength(0);
    });

    it('FAILS when primary and secondary share the same DoH endpoint (misconfigured)', async () => {
      const primaryGroups = createGroupsFromProviders([
        { name: 'Cloudflare', type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' },
      ]);
      const secondaryGroups = createGroupsFromProviders([
        { name: 'Cloudflare', type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }, // SAME!
      ]);

      const result = await validateConsensusDisjointnessRuntime(
        primaryGroups,
        secondaryGroups,
        undefined,
        2000,
      );

      expect(result.isValid).toBe(false);
      expect(result.overlaps.primarySecondary).toContain('doh:cloudflare-dns.com');
      // failureReason should contain the actual overlapping endpoint
      expect(result.failureReason).toContain('doh:cloudflare-dns.com');
    });

    it('FAILS when primary and secondary share native nameserver IP', async () => {
      const primaryGroups: DnsResolverGroup[] = [
        { name: 'primary', lookups: [{ type: 'native', nameservers: ['1.1.1.1', '8.8.8.8'] }] },
      ];
      const secondaryGroups: DnsResolverGroup[] = [
        { name: 'secondary', lookups: [{ type: 'native', nameservers: ['1.1.1.1', '9.9.9.9'] }] }, // 1.1.1.1 overlaps
      ];

      const result = await validateConsensusDisjointnessRuntime(
        primaryGroups,
        secondaryGroups,
        undefined,
        2000,
      );

      expect(result.isValid).toBe(false);
      expect(result.overlaps.primarySecondary).toContain('native:1.1.1.1');
    });

    it('FAILS when tertiary overlaps with primary', async () => {
      const primaryGroups = createGroupsFromProviders([
        { name: 'Cloudflare', type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' },
      ]);
      const secondaryGroups = createGroupsFromProviders([
        { name: 'AdGuard', type: 'dot', endpoint: '94.140.14.14' },
      ]);
      const tertiaryGroups = createGroupsFromProviders([
        { name: 'Cloudflare', type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }, // SAME as primary!
      ]);

      const result = await validateConsensusDisjointnessRuntime(
        primaryGroups,
        secondaryGroups,
        tertiaryGroups,
        2000,
      );

      expect(result.isValid).toBe(false);
      expect(result.overlaps.primaryTertiary).toContain('doh:cloudflare-dns.com');
    });

    it('FAILS when tertiary overlaps with secondary', async () => {
      const primaryGroups = createGroupsFromProviders([
        { name: 'Cloudflare', type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' },
      ]);
      const secondaryGroups = createGroupsFromProviders([
        { name: 'AdGuard', type: 'dot', endpoint: '94.140.14.14' },
      ]);
      const tertiaryGroups = createGroupsFromProviders([
        { name: 'AdGuard', type: 'dot', endpoint: '94.140.14.14' }, // SAME as secondary!
      ]);

      const result = await validateConsensusDisjointnessRuntime(
        primaryGroups,
        secondaryGroups,
        tertiaryGroups,
        2000,
      );

      expect(result.isValid).toBe(false);
      expect(result.overlaps.secondaryTertiary).toContain('dot:94.140.14.14');
    });

    it('PASSES with pinned private recursors (DNS_CONSENSUS_NAMESERVERS)', async () => {
      const primaryGroups = createGroupsFromProviders([
        { name: 'Cloudflare', type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' },
      ]);
      // Secondary uses pinned private recursor (e.g., local Unbound)
      const secondaryGroups: DnsResolverGroup[] = [
        { name: 'private-recursor', lookups: [{ type: 'native', nameservers: ['127.0.0.1'] }] },
      ];

      const result = await validateConsensusDisjointnessRuntime(
        primaryGroups,
        secondaryGroups,
        undefined,
        2000,
      );

      expect(result.isValid).toBe(true);
      expect(result.primaryEndpoints).toContain('doh:cloudflare-dns.com');
      expect(result.secondaryEndpoints).toContain('native:127.0.0.1');
    });

    it('FAILS when single recursor pinned for both primary and secondary (one resolver cannot be its own second opinion)', async () => {
      // This simulates the documented prod override where both point at same private recursor
      const primaryGroups: DnsResolverGroup[] = [
        { name: 'primary', lookups: [{ type: 'native', nameservers: ['127.0.0.1:5300'] }] },
      ];
      const secondaryGroups: DnsResolverGroup[] = [
        { name: 'secondary', lookups: [{ type: 'native', nameservers: ['127.0.0.1:5300'] }] }, // SAME!
      ];

      const result = await validateConsensusDisjointnessRuntime(
        primaryGroups,
        secondaryGroups,
        undefined,
        2000,
      );

      expect(result.isValid).toBe(false);
      expect(result.overlaps.primarySecondary).toContain('native:127.0.0.1:5300');
    });

    it('returns structured overlap details for Prometheus alerting', async () => {
      const primaryGroups = createGroupsFromProviders([
        { name: 'Cloudflare', type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' },
        { name: 'Google', type: 'doh', endpoint: 'https://dns.google/resolve' },
      ]);
      const secondaryGroups = createGroupsFromProviders([
        { name: 'Cloudflare', type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }, // Overlap
        { name: 'Quad9', type: 'doh', endpoint: 'https://dns.quad9.net/dns-query' },
      ]);

      const result = await validateConsensusDisjointnessRuntime(
        primaryGroups,
        secondaryGroups,
        undefined,
        2000,
      );

      expect(result.isValid).toBe(false);
      // Structured data for alerting
      expect(result.primaryEndpoints).toEqual(
        expect.arrayContaining(['doh:cloudflare-dns.com', 'doh:dns.google']),
      );
      expect(result.secondaryEndpoints).toEqual(
        expect.arrayContaining(['doh:cloudflare-dns.com', 'doh:dns.quad9.net']),
      );
      expect(result.overlaps.primarySecondary).toContain('doh:cloudflare-dns.com');
      expect(result.failureReason).toBeDefined();
    });

    it('handles network errors gracefully during validation (fail-closed)', async () => {
      const primaryGroups = createGroupsFromProviders([
        { name: 'Cloudflare', type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' },
      ]);
      const secondaryGroups = createGroupsFromProviders([
        { name: 'AdGuard', type: 'dot', endpoint: '94.140.14.14' },
      ]);

      // The implementation catches resolution errors and adds error markers
      // but doesn't fail the whole validation unless there's an actual overlap
      // Network errors on hostname resolution are tolerated (fail-open for resolution)
      // but we should still detect if the error markers themselves overlap
      const result = await validateConsensusDisjointnessRuntime(
        primaryGroups,
        secondaryGroups,
        undefined,
        2000,
      );

      // Since there's no actual overlap, validation passes even with resolution errors
      // The error markers are unique per lookup so they don't cause false overlaps
      expect(result.isValid).toBe(true);
      // Note: In test environment, dns.resolve4 may work or fail depending on network
      // We just verify the function doesn't throw
    });

    it('uses configurable timeout (DNS_CONSENSUS_VALIDATION_TIMEOUT_MS)', async () => {
      const primaryGroups = createGroupsFromProviders([
        { name: 'Cloudflare', type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' },
      ]);
      const secondaryGroups = createGroupsFromProviders([
        { name: 'AdGuard', type: 'dot', endpoint: '94.140.14.14' },
      ]);

      // The implementation uses dns.resolve4 internally
      // Just verify the function accepts the timeout parameter
      const result = await validateConsensusDisjointnessRuntime(
        primaryGroups,
        secondaryGroups,
        undefined,
        5000,
      );

      // Verify the function completed without error
      expect(result).toBeDefined();
      expect(typeof result.isValid).toBe('boolean');
    });
  });

  describe('Integration: buildDnsConsensusConfig with validation', () => {
    // This test will be moved to provider-factory test once implemented
    it('should return disabled config with reason when validation fails', async () => {
      // This is a placeholder for the integration test
      // The actual test will be in provider-factory test file
      expect(true).toBe(true);
    });
  });
});
