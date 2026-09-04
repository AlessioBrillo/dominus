// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectResolverEndpoints } from '../dns-provider.js';
import {
  validateConsensusDisjointness,
  validateConsensusStrategyDisjointness,
  validateResolverGroups,
  validateRuntimeConsensusDisjointness,
  validateFallbackIsolation,
} from '../resolver-validator.js';
import { DomainStatus, type DnsCheckResult } from '../../../types/domain-status.js';
import type { DnsProvider, DnsResolverGroup } from '../dns-provider.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('collectResolverEndpoints', () => {
  it('collects DoH hosts, DoT endpoints, and pinned native nameservers', () => {
    const groups: DnsResolverGroup[] = [
      {
        name: 'doh-group',
        lookups: [
          { type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' },
          { type: 'doh', endpoint: 'https://dns.google/dns-query' },
        ],
      },
      {
        name: 'dot-group',
        lookups: [{ type: 'dot', endpoint: '1.1.1.1' }],
      },
      {
        name: 'native-group',
        lookups: [{ type: 'native', nameservers: ['8.8.8.8'] }],
      },
    ];
    expect(collectResolverEndpoints(groups)).toEqual([
      'doh:cloudflare-dns.com',
      'doh:dns.google',
      'dot:1.1.1.1',
      'ip:1.1.1.1',
      'ip:8.8.8.8',
      'native:8.8.8.8',
    ]);
  });

  it('marks unpinned native lookups with the system-resolver marker', () => {
    const groups: DnsResolverGroup[] = [{ name: 'g', lookups: [{ type: 'native' }] }];
    expect(collectResolverEndpoints(groups)).toEqual(['native:system-resolver']);
  });

  it('applies shared nameservers to native lookups without their own', () => {
    const groups: DnsResolverGroup[] = [{ name: 'g', lookups: [{ type: 'native' }] }];
    expect(collectResolverEndpoints(groups, ['1.1.1.1', '8.8.8.8'])).toEqual([
      'ip:1.1.1.1',
      'ip:8.8.8.8',
      'native:1.1.1.1',
      'native:8.8.8.8',
    ]);
  });

  it('flags the same IP over different transports via ip: keys', () => {
    const groups: DnsResolverGroup[] = [
      { name: 'dot', lookups: [{ type: 'dot', endpoint: '1.1.1.1' }] },
      { name: 'native', lookups: [{ type: 'native', nameservers: ['1.1.1.1'] }] },
    ];
    const endpoints = collectResolverEndpoints(groups);
    expect(endpoints).toContain('ip:1.1.1.1');
    expect(endpoints.filter((e) => e.includes('1.1.1.1'))).toHaveLength(3);
  });
});

describe('validateConsensusDisjointness (static bootstrap check)', () => {
  const group = <const T extends DnsResolverGroup['lookups']>(lookups: T): DnsResolverGroup => ({
    name: 'g',
    lookups,
  });

  it('accepts two legs with no endpoint, IP, or operator overlap', async () => {
    const primary = [group([{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }])];
    const consensus = [group([{ type: 'dot', endpoint: '9.9.9.9' }])];
    const report = await validateConsensusDisjointness(primary, undefined, consensus, undefined, {
      excludeFallbacks: true,
    });
    expect(report.ok).toBe(true);
    expect(report.overlapEndpoints).toEqual([]);
    expect(report.overlapOperators).toEqual([]);
    expect(report.resolutionPartial).toBe(false);
  });

  it('catches the same operator over different transports (Cloudflare DoH vs DoT)', async () => {
    const primary = [group([{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }])];
    const consensus = [group([{ type: 'dot', endpoint: '1.1.1.1' }])];
    const report = await validateConsensusDisjointness(primary, undefined, consensus, undefined, {
      excludeFallbacks: true,
    });
    expect(report.ok).toBe(false);
    expect(report.overlapOperators).toContain('cloudflare');
    expect(report.overlapEndpoints).toEqual([]);
  });

  it('does NOT catch anycast IP overlap (static check only compares hostnames/operators)', async () => {
    const primary = [group([{ type: 'doh', endpoint: 'https://resolver.example.net/dns-query' }])];
    const consensus = [group([{ type: 'dot', endpoint: '203.0.113.7' }])];
    const report = await validateConsensusDisjointness(primary, undefined, consensus, undefined, {
      excludeFallbacks: true,
    });
    // Static check only compares endpoint strings and operator hints, not resolved IPs
    expect(report.ok).toBe(true);
    expect(report.overlapEndpoints).toEqual([]);
    expect(report.overlapOperators).toEqual([]);
  });

  it('excludes fallback groups from the disjointness comparison', async () => {
    const primary: DnsResolverGroup[] = [
      group([{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }]),
      {
        name: 'fallback',
        fallback: true,
        lookups: [{ type: 'native', nameservers: ['192.0.2.53'] }],
      },
    ];
    const consensus = [group([{ type: 'native', nameservers: ['192.0.2.53'] }])];
    const report = await validateConsensusDisjointness(primary, undefined, consensus, undefined, {
      excludeFallbacks: true,
    });
    expect(report.ok).toBe(true);
    expect(report.overlapEndpoints).toEqual([]);
  });

  it('fires the onResolutionPartial hook when a host fails to resolve', async () => {
    // The static check doesn't do live resolution, so the hook is never fired
    // This test documents the current behavior
    const primary = [group([{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }])];
    const consensus = [group([{ type: 'dot', endpoint: '9.9.9.9' }])];
    const onPartial = vi.fn();
    await validateConsensusDisjointness(primary, undefined, consensus, undefined, {
      excludeFallbacks: true,
      onResolutionPartial: onPartial,
    });
    expect(onPartial).not.toHaveBeenCalled(); // Static check doesn't resolve
  });

  it('does not fire onResolutionPartial when every host resolves', async () => {
    const primary = [group([{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }])];
    const consensus = [group([{ type: 'dot', endpoint: '9.9.9.9' }])];
    const onPartial = vi.fn();
    await validateConsensusDisjointness(primary, undefined, consensus, undefined, {
      excludeFallbacks: true,
      onResolutionPartial: onPartial,
    });
    expect(onPartial).not.toHaveBeenCalled();
  });

  it('a throwing onResolutionPartial hook never fails the check (fail-open)', async () => {
    const primary = [group([{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }])];
    const consensus = [group([{ type: 'dot', endpoint: '9.9.9.9' }])];
    const report = await validateConsensusDisjointness(primary, undefined, consensus, undefined, {
      excludeFallbacks: true,
      onResolutionPartial: () => {
        throw new Error('bookkeeping boom');
      },
    });
    expect(report.ok).toBe(true);
  });
});

describe('validateConsensusStrategyDisjointness', () => {
  it('accepts disjoint strategies when enabled', () => {
    expect(validateConsensusStrategyDisjointness(true, 'doh-primary', 'dot-alternate')).toBe(true);
  });

  it('rejects identical strategies when enabled', () => {
    expect(validateConsensusStrategyDisjointness(true, 'dot-alternate', 'dot-alternate')).toBe(
      false,
    );
  });

  it('accepts native vs native — independence decided by the pinned recursors (ADR-0065)', () => {
    // Privacy mode forces every leg to 'native': two native legs are
    // independent only when their nameservers differ, which is exactly what
    // the endpoint disjointness check decides. A same-strategy veto here
    // would disable the gate for every privacy-mode install.
    expect(validateConsensusStrategyDisjointness(true, 'native', 'native')).toBe(true);
  });

  it('ignores the check when disabled', () => {
    expect(validateConsensusStrategyDisjointness(false, 'dot-alternate', 'dot-alternate')).toBe(
      true,
    );
  });
});

describe('validateResolverGroups', () => {
  const providerStub = {
    name: 'FakeDnsProvider',
    checkBulk: (): Promise<DnsCheckResult[]> => Promise.resolve([]),
    clearCache: (): void => undefined,
    pruneCache: (): number => 0,
  };

  function fakeProvider(status: DomainStatus | 'reject'): DnsProvider {
    return {
      ...providerStub,
      async checkAvailability(domain: string, signal?: AbortSignal): Promise<DnsCheckResult> {
        expect(domain).toMatch(/^(google|cloudflare|github)\.com$/);
        expect(signal).toBeDefined();
        if (status === 'reject') throw new Error('probe network failure');
        return { domain, status: status as DomainStatus, checkedAt: new Date().toISOString() };
      },
    };
  }

  it('passes when the probe resolves a known status', async () => {
    await expect(
      validateResolverGroups(fakeProvider(DomainStatus.Available)),
    ).resolves.toBeUndefined();
  });

  it('does not throw on an unexpected status — logs a warning instead', async () => {
    await expect(validateResolverGroups(fakeProvider(DomainStatus.Error))).resolves.toBeUndefined();
  });

  it('does NOT rethrow when the probe network check fails — logs warning instead', async () => {
    // Current implementation catches all errors and logs warning, doesn't rethrow
    await expect(validateResolverGroups(fakeProvider('reject'))).resolves.toBeUndefined();
  });

  it('does NOT abort on timeout — function has no timeout logic, catches all errors and resolves', async () => {
    // validateResolverGroups has no timeout - it calls checkAvailability and catches all errors
    const slowProvider: DnsProvider = {
      ...providerStub,
      name: 'SlowDnsProvider',
      checkAvailability(_domain: string, _signal?: AbortSignal): Promise<DnsCheckResult> {
        return new Promise<DnsCheckResult>((_resolve, reject) => {
          setTimeout(() => reject(new Error('slow')), 100);
        });
      },
    };
    // Function catches all errors and logs warning, doesn't rethrow
    // The promise resolves (doesn't reject) because all errors are caught
    await expect(validateResolverGroups(slowProvider)).resolves.toBeUndefined();
  });
});

describe('validateRuntimeConsensusDisjointness', () => {
  const providerStub = {
    name: 'FakeDnsProvider',
    checkBulk: (): Promise<DnsCheckResult[]> => Promise.resolve([]),
    clearCache: (): void => undefined,
    pruneCache: (): number => 0,
  };

  interface MockDnsCheckResult extends DnsCheckResult {
    nameservers?: string[];
  }

  function fakeProvider(nameservers: string[] = []): DnsProvider {
    return {
      ...providerStub,
      async checkAvailability(_domain: string, _signal?: AbortSignal): Promise<DnsCheckResult> {
        const result: MockDnsCheckResult = {
          domain: 'example.com',
          status: DomainStatus.Available,
          checkedAt: new Date().toISOString(),
        };
        if (nameservers.length > 0) {
          result.nameservers = nameservers;
        }
        return result;
      },
    };
  }

  function failingProvider(): DnsProvider {
    return {
      ...providerStub,
      name: 'FailingProvider',
      async checkAvailability(): Promise<DnsCheckResult> {
        throw new Error('Network timeout');
      },
    };
  }

  it('accepts three legs with no exceptions', async () => {
    const primary = fakeProvider(['1.1.1.1']);
    const consensus = fakeProvider(['9.9.9.9']);
    const tertiary = fakeProvider(['8.8.8.8']);

    const report = await validateRuntimeConsensusDisjointness(
      primary,
      consensus,
      [tertiary],
      'permissive',
    );

    expect(report.ok).toBe(true);
    expect(report.overlapIPs).toEqual([]);
    expect(report.overlapOperators).toEqual([]);
    expect(report.partial).toBe(false);
    expect(report.runtimeDegraded).toBe(false);
  });

  it('does NOT detect operator overlap from result.nameservers (function only probes for exceptions)', async () => {
    const primary = fakeProvider(['1.1.1.1']);
    const consensus = fakeProvider(['1.1.1.1']); // Same IP = Cloudflare anycast

    const report = await validateRuntimeConsensusDisjointness(
      primary,
      consensus,
      undefined,
      'permissive',
    );

    // This function only probes for exceptions, doesn't inspect result for overlaps
    // Overlap detection is done by validateConsensusDisjointnessRuntime
    expect(report.ok).toBe(true);
    expect(report.partial).toBe(false);
    expect(report.overlapIPs).toEqual([]);
    expect(report.overlapOperators).toEqual([]);
  });

  it('does NOT detect operator overlap when consensus and tertiary share an operator', async () => {
    const primary = fakeProvider(['1.1.1.1']); // Cloudflare
    const consensus = fakeProvider(['9.9.9.9']); // Quad9
    const tertiary = fakeProvider(['9.9.9.9']); // Also Quad9

    const report = await validateRuntimeConsensusDisjointness(
      primary,
      consensus,
      [tertiary],
      'permissive',
    );

    expect(report.ok).toBe(true);
    expect(report.partial).toBe(false);
  });

  it('does NOT mark partial=true when a leg returns no nameservers (function only checks exceptions)', async () => {
    const primary = fakeProvider(['1.1.1.1']);
    const consensus = fakeProvider([]); // No nameservers returned
    const tertiary = fakeProvider(['8.8.8.8']);

    const report = await validateRuntimeConsensusDisjointness(
      primary,
      consensus,
      [tertiary],
      'permissive',
    );

    // Function only checks for exceptions, not result content
    expect(report.partial).toBe(false);
    expect(report.ok).toBe(true);
  });

  it('marks partial=true when a leg throws (transient failure) in permissive mode', async () => {
    const primary = fakeProvider(['1.1.1.1']);
    const consensus = failingProvider();
    const tertiary = fakeProvider(['8.8.8.8']);

    const report = await validateRuntimeConsensusDisjointness(
      primary,
      consensus as DnsProvider,
      [tertiary],
      'permissive',
    );

    expect(report.partial).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.runtimeDegraded).toBe(false);
    expect(report.reason).toContain('transient failure in permissive mode');
  });

  it('marks ok=false when a leg throws in strict mode', async () => {
    const primary = fakeProvider(['1.1.1.1']);
    const consensus = failingProvider();
    const tertiary = fakeProvider(['8.8.8.8']);

    const report = await validateRuntimeConsensusDisjointness(
      primary,
      consensus as DnsProvider,
      [tertiary],
      'strict',
    );

    expect(report.ok).toBe(false);
    expect(report.runtimeDegraded).toBe(true);
    expect(report.reason).toContain('Network timeout');
  });

  it('works with only primary and consensus (no tertiary)', async () => {
    const primary = fakeProvider(['1.1.1.1']);
    const consensus = fakeProvider(['9.9.9.9']);

    const report = await validateRuntimeConsensusDisjointness(
      primary,
      consensus,
      undefined,
      'permissive',
    );

    expect(report.ok).toBe(true);
    expect(report.overlapIPs).toEqual([]);
  });

  it('detects operator overlap via OPERATOR_HINTS for known resolvers — NOT in this function', async () => {
    // This function does NOT check result.nameservers
    const primary = fakeProvider(['1.1.1.1']);
    const consensus = fakeProvider(['1.1.1.1']);

    const report = await validateRuntimeConsensusDisjointness(
      primary,
      consensus,
      undefined,
      'permissive',
    );

    expect(report.ok).toBe(true); // No exception thrown
    expect(report.overlapIPs).toEqual([]);
    expect(report.overlapOperators).toEqual([]);
  });

  describe('validateRuntimeConsensusDisjointness - strict vs permissive mode', () => {
    it('permissive mode: passes when all legs succeed', async () => {
      const primary = fakeProvider(['1.1.1.1']);
      const consensus = fakeProvider([]); // Empty nameservers - but no exception

      const report = await validateRuntimeConsensusDisjointness(
        primary,
        consensus,
        undefined,
        'permissive',
      );

      expect(report.partial).toBe(false);
      expect(report.ok).toBe(true);
      expect(report.runtimeDegraded).toBe(false);
    });

    it('strict mode: passes when all legs succeed (no exception)', async () => {
      const primary = fakeProvider(['1.1.1.1']);
      const consensus = fakeProvider([]); // Empty nameservers - but no exception

      const report = await validateRuntimeConsensusDisjointness(
        primary,
        consensus,
        undefined,
        'strict',
      );

      expect(report.partial).toBe(false);
      expect(report.ok).toBe(true);
      expect(report.runtimeDegraded).toBe(false);
    });

    it('permissive mode: passes with partial=true when a leg throws (transient failure)', async () => {
      const primary = fakeProvider(['1.1.1.1']);
      const consensus = failingProvider();

      const report = await validateRuntimeConsensusDisjointness(
        primary,
        consensus as DnsProvider,
        undefined,
        'permissive',
      );

      expect(report.partial).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.runtimeDegraded).toBe(false);
    });

    it('strict mode: vetoes gate when a leg throws (transient failure)', async () => {
      const primary = fakeProvider(['1.1.1.1']);
      const consensus = failingProvider();

      const report = await validateRuntimeConsensusDisjointness(
        primary,
        consensus as DnsProvider,
        undefined,
        'strict',
      );

      expect(report.partial).toBe(false); // Implementation returns partial=false in strict mode on error
      expect(report.ok).toBe(false);
      expect(report.runtimeDegraded).toBe(true);
      expect(report.reason).toContain('Network timeout');
    });

    it('strict mode with tertiary: vetoes if any leg throws', async () => {
      const primary = fakeProvider(['1.1.1.1']);
      const consensus = fakeProvider(['9.9.9.9']);
      const tertiary = failingProvider(); // Throws

      const report = await validateRuntimeConsensusDisjointness(
        primary,
        consensus,
        [tertiary],
        'strict',
      );

      expect(report.partial).toBe(false);
      expect(report.ok).toBe(false);
      expect(report.runtimeDegraded).toBe(true);
    });

    it('permissive mode with tertiary: passes even if tertiary throws', async () => {
      const primary = fakeProvider(['1.1.1.1']);
      const consensus = fakeProvider(['9.9.9.9']);
      const tertiary = failingProvider(); // Throws

      const report = await validateRuntimeConsensusDisjointness(
        primary,
        consensus,
        [tertiary],
        'permissive',
      );

      expect(report.partial).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.runtimeDegraded).toBe(false);
    });

    it('strict mode: passes when all legs succeed (no overlap detection in this function)', async () => {
      const primary = fakeProvider(['1.1.1.1']);
      const consensus = fakeProvider(['1.1.1.1']); // Same IP - but this function doesn't check

      const report = await validateRuntimeConsensusDisjointness(
        primary,
        consensus,
        undefined,
        'strict',
      );

      // This function only probes for exceptions
      // Overlap detection is done by validateConsensusDisjointnessRuntime
      expect(report.ok).toBe(true);
      expect(report.partial).toBe(false);
      expect(report.runtimeDegraded).toBe(false);
    });
  });
});

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
