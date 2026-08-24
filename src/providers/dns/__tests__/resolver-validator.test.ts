// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectResolverEndpoints, strategyToResolverGroups } from '../dns-provider.js';
import {
  validateConsensusDisjointness,
  validateConsensusEndpointDisjointness,
  validateConsensusStrategyDisjointness,
  validateResolverGroups,
  validateRuntimeConsensusDisjointness,
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

describe('validateConsensusEndpointDisjointness', () => {
  it('accepts strategies with no shared endpoints', () => {
    const primary = collectResolverEndpoints(
      strategyToResolverGroups('doh-primary', 'https://cloudflare-dns.com/dns-query'),
    );
    const consensus = collectResolverEndpoints(
      strategyToResolverGroups('dot-only', 'https://cloudflare-dns.com/dns-query'),
    );
    expect(validateConsensusEndpointDisjointness(primary, consensus)).toBe(true);
  });

  it('rejects strategies that reuse DoH endpoints (name-level rubber stamp)', () => {
    const primary = collectResolverEndpoints(
      strategyToResolverGroups('doh-only', 'https://cloudflare-dns.com/dns-query'),
    );
    const consensus = collectResolverEndpoints(
      strategyToResolverGroups('doh-primary', 'https://cloudflare-dns.com/dns-query'),
    );
    expect(validateConsensusEndpointDisjointness(primary, consensus)).toBe(false);
  });

  it('rejects a pinned native consensus reusing the DoT resolver IPs', () => {
    const primary = collectResolverEndpoints(
      strategyToResolverGroups('dot-only', 'https://cloudflare-dns.com/dns-query'),
    );
    const consensus = collectResolverEndpoints(
      strategyToResolverGroups('native', 'https://cloudflare-dns.com/dns-query'),
      ['1.1.1.1'],
    );
    expect(validateConsensusEndpointDisjointness(primary, consensus)).toBe(false);
  });

  it('rejects an unpinned native consensus on both sides of the same system resolver', () => {
    const primary = collectResolverEndpoints(
      strategyToResolverGroups('native', 'https://cloudflare-dns.com/dns-query'),
    );
    const consensus = collectResolverEndpoints(
      strategyToResolverGroups('native-with-doh-fallback', 'https://cloudflare-dns.com/dns-query'),
    );
    expect(validateConsensusEndpointDisjointness(primary, consensus)).toBe(false);
  });
});

describe('validateConsensusDisjointness', () => {
  const resolveAs =
    (map: Record<string, string[]>): ((host: string) => Promise<string[]>) =>
    (host: string) =>
      Promise.resolve(map[host] ?? []);

  const group = <const T extends DnsResolverGroup['lookups']>(lookups: T): DnsResolverGroup => ({
    name: 'g',
    lookups,
  });

  it('accepts two legs with no endpoint, IP, or operator overlap', async () => {
    const primary = [group([{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }])];
    const consensus = [group([{ type: 'dot', endpoint: '9.9.9.9' }])];
    const report = await validateConsensusDisjointness(primary, undefined, consensus, undefined, {
      resolveHost: resolveAs({ 'cloudflare-dns.com': ['1.1.1.1'] }),
    });
    expect(report.ok).toBe(true);
    expect(report.overlapEndpoints).toEqual([]);
    expect(report.overlapOperators).toEqual([]);
    expect(report.resolutionPartial).toBe(false);
  });

  it('catches the same operator over different transports (Cloudflare DoH vs DoT)', async () => {
    // P1: doh:cloudflare-dns.com vs dot:1.1.1.1 share no string endpoint but
    // are the same anycast operator — not an independent second opinion.
    const primary = [group([{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }])];
    const consensus = [group([{ type: 'dot', endpoint: '1.1.1.1' }])];
    const report = await validateConsensusDisjointness(primary, undefined, consensus, undefined, {
      resolveHost: resolveAs({ 'cloudflare-dns.com': ['1.2.3.4'] }),
    });
    expect(report.ok).toBe(false);
    expect(report.overlapOperators).toContain('cloudflare');
    expect(report.overlapEndpoints).toEqual([]);
  });

  it('catches the same anycast IP behind two transports even for unknown operators', async () => {
    const primary = [group([{ type: 'doh', endpoint: 'https://resolver.example.net/dns-query' }])];
    const consensus = [group([{ type: 'dot', endpoint: '203.0.113.7' }])];
    const report = await validateConsensusDisjointness(primary, undefined, consensus, undefined, {
      resolveHost: resolveAs({ 'resolver.example.net': ['203.0.113.7'] }),
    });
    expect(report.ok).toBe(false);
    expect(report.overlapEndpoints).toContain('ip:203.0.113.7');
  });

  it('keeps the gate decided when a host fails to resolve — records partial resolution', async () => {
    const primary = [group([{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }])];
    const consensus = [group([{ type: 'dot', endpoint: '9.9.9.9' }])];
    const report = await validateConsensusDisjointness(primary, undefined, consensus, undefined, {
      resolveHost: resolveAs({}),
    });
    expect(report.ok).toBe(true);
    expect(report.resolutionPartial).toBe(true);
  });

  it('fires the onResolutionPartial hook when a host fails to resolve (ADR-0065)', async () => {
    // The strongest overlap proof (resolved-IP comparison) silently degrades
    // to hostname/operator hints on a slow boot; the hook lets the metrics
    // collector surface how often that happens.
    const primary = [group([{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }])];
    const consensus = [group([{ type: 'dot', endpoint: '9.9.9.9' }])];
    const onPartial = vi.fn();
    await validateConsensusDisjointness(primary, undefined, consensus, undefined, {
      resolveHost: resolveAs({}),
      onResolutionPartial: onPartial,
    });
    expect(onPartial).toHaveBeenCalledTimes(1);
  });

  it('does not fire onResolutionPartial when every host resolves', async () => {
    const primary = [group([{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }])];
    const consensus = [group([{ type: 'dot', endpoint: '9.9.9.9' }])];
    const onPartial = vi.fn();
    await validateConsensusDisjointness(primary, undefined, consensus, undefined, {
      resolveHost: resolveAs({ 'cloudflare-dns.com': ['1.1.1.1'] }),
      onResolutionPartial: onPartial,
    });
    expect(onPartial).not.toHaveBeenCalled();
  });

  it('a throwing onResolutionPartial hook never fails the check (fail-open)', async () => {
    const primary = [group([{ type: 'doh', endpoint: 'https://cloudflare-dns.com/dns-query' }])];
    const consensus = [group([{ type: 'dot', endpoint: '9.9.9.9' }])];
    const report = await validateConsensusDisjointness(primary, undefined, consensus, undefined, {
      resolveHost: resolveAs({}),
      onResolutionPartial: () => {
        throw new Error('bookkeeping boom');
      },
    });
    expect(report.ok).toBe(true);
    expect(report.resolutionPartial).toBe(true);
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
});

describe('validateConsensusStrategyDisjointness', () => {
  it('accepts disjoint strategies when enabled', () => {
    expect(validateConsensusStrategyDisjointness(true, 'doh-primary', 'dot-only')).toBe(true);
  });

  it('rejects identical strategies when enabled', () => {
    expect(validateConsensusStrategyDisjointness(true, 'dot-only', 'dot-only')).toBe(false);
  });

  it('accepts native vs native — independence decided by the pinned recursors (ADR-0065)', () => {
    // Privacy mode forces every leg to 'native': two native legs are
    // independent only when their nameservers differ, which is exactly what
    // the endpoint disjointness check decides. A same-strategy veto here
    // would disable the gate for every privacy-mode install.
    expect(validateConsensusStrategyDisjointness(true, 'native', 'native')).toBe(true);
  });

  it('ignores the check when disabled', () => {
    expect(validateConsensusStrategyDisjointness(false, 'dot-only', 'dot-only')).toBe(true);
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

  it('rethrows when the probe network check fails', async () => {
    await expect(validateResolverGroups(fakeProvider('reject'))).rejects.toThrow(
      'probe network failure',
    );
  });

  it('aborts the probe after the validation timeout', async () => {
    vi.useFakeTimers();
    try {
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
      let capturedSignal: AbortSignal | undefined;
      const slowProvider: DnsProvider = {
        ...providerStub,
        name: 'SlowDnsProvider',
        checkAvailability(_domain: string, signal?: AbortSignal): Promise<DnsCheckResult> {
          capturedSignal = signal;
          return new Promise<DnsCheckResult>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('AbortError')));
          });
        },
      };
      const pending = validateResolverGroups(slowProvider);
      pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(pending).rejects.toThrow('AbortError');
      expect(abortSpy).toHaveBeenCalled();
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

  it('accepts three legs with no IP or operator overlap', async () => {
    const primary = fakeProvider(['1.1.1.1']);
    const consensus = fakeProvider(['9.9.9.9']);
    const tertiary = fakeProvider(['8.8.8.8']);

    const report = await validateRuntimeConsensusDisjointness(primary, consensus, tertiary);

    expect(report.ok).toBe(true);
    expect(report.overlapIPs).toEqual([]);
    expect(report.overlapOperators).toEqual([]);
    expect(report.partial).toBe(false);
  });

  it('rejects when primary and consensus share an IP (same anycast)', async () => {
    const primary = fakeProvider(['1.1.1.1']);
    const consensus = fakeProvider(['1.1.1.1']); // Same IP = Cloudflare anycast

    const report = await validateRuntimeConsensusDisjointness(primary, consensus);

    expect(report.ok).toBe(false);
    expect(report.overlapIPs).toContain('1.1.1.1');
    expect(report.overlapOperators).toContain('cloudflare');
  });

  it('rejects when consensus and tertiary share an operator', async () => {
    const primary = fakeProvider(['1.1.1.1']); // Cloudflare
    const consensus = fakeProvider(['9.9.9.9']); // Quad9
    const tertiary = fakeProvider(['9.9.9.9']); // Also Quad9

    const report = await validateRuntimeConsensusDisjointness(primary, consensus, tertiary);

    expect(report.ok).toBe(false);
    expect(report.overlapIPs).toContain('9.9.9.9');
    expect(report.overlapOperators).toContain('quad9');
  });

  it('marks partial=true when a leg returns no nameservers', async () => {
    const primary = fakeProvider(['1.1.1.1']);
    const consensus = fakeProvider([]); // No nameservers returned
    const tertiary = fakeProvider(['8.8.8.8']);

    const report = await validateRuntimeConsensusDisjointness(primary, consensus, tertiary);

    expect(report.partial).toBe(true);
    // Gate stays enabled on partial, just logged
  });

  it('marks partial=true when a leg throws (transient failure)', async () => {
    const primary = fakeProvider(['1.1.1.1']);
    const consensus = {
      ...providerStub,
      name: 'FailingProvider',
      async checkAvailability(): Promise<DnsCheckResult> {
        throw new Error('Network timeout');
      },
    };
    const tertiary = fakeProvider(['8.8.8.8']);

    const report = await validateRuntimeConsensusDisjointness(
      primary,
      consensus as DnsProvider,
      tertiary,
    );

    expect(report.partial).toBe(true);
  });

  it('works with only primary and consensus (no tertiary)', async () => {
    const primary = fakeProvider(['1.1.1.1']);
    const consensus = fakeProvider(['9.9.9.9']);

    const report = await validateRuntimeConsensusDisjointness(primary, consensus);

    expect(report.ok).toBe(true);
    expect(report.overlapIPs).toEqual([]);
  });

  it('detects operator overlap via OPERATOR_HINTS for known resolvers', async () => {
    // Cloudflare DoH (1.1.1.1) vs Cloudflare DoT (1.1.1.1) — same operator, different transport
    const primary = fakeProvider(['1.1.1.1']);
    const consensus = fakeProvider(['1.1.1.1']);

    const report = await validateRuntimeConsensusDisjointness(primary, consensus);

    expect(report.ok).toBe(false);
    expect(report.overlapOperators).toContain('cloudflare');
  });

  describe('validateRuntimeConsensusDisjointness - strict vs permissive mode', () => {
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

    it('permissive mode (default): passes with partial=true when a leg returns no nameservers', async () => {
      const primary = fakeProvider(['1.1.1.1']);
      const consensus = fakeProvider([]); // No nameservers returned

      const report = await validateRuntimeConsensusDisjointness(primary, consensus, undefined, 'permissive');

      expect(report.partial).toBe(true);
      expect(report.ok).toBe(true); // Gate stays enabled in permissive mode
      expect(report.runtimeDegraded).toBe(false);
    });

    it('strict mode: vetoes gate (ok=false, runtimeDegraded=true) when a leg returns no nameservers', async () => {
      const primary = fakeProvider(['1.1.1.1']);
      const consensus = fakeProvider([]); // No nameservers returned

      const report = await validateRuntimeConsensusDisjointness(primary, consensus, undefined, 'strict');

      expect(report.partial).toBe(true);
      expect(report.ok).toBe(false); // Gate vetoed in strict mode
      expect(report.runtimeDegraded).toBe(true);
      expect(report.reason).toContain('incomplete');
    });

    it('permissive mode: passes with partial=true when a leg throws (transient failure)', async () => {
      const primary = fakeProvider(['1.1.1.1']);
      const consensus = failingProvider();

      const report = await validateRuntimeConsensusDisjointness(primary, consensus as DnsProvider, undefined, 'permissive');

      expect(report.partial).toBe(true);
      expect(report.ok).toBe(true); // Gate stays enabled in permissive mode
      expect(report.runtimeDegraded).toBe(false);
    });

    it('strict mode: vetoes gate when a leg throws (transient failure)', async () => {
      const primary = fakeProvider(['1.1.1.1']);
      const consensus = failingProvider();

      const report = await validateRuntimeConsensusDisjointness(primary, consensus as DnsProvider, undefined, 'strict');

      expect(report.partial).toBe(true);
      expect(report.ok).toBe(false);
      expect(report.runtimeDegraded).toBe(true);
      expect(report.reason).toContain('incomplete');
    });

    it('strict mode with tertiary: vetoes if any leg is partial', async () => {
      const primary = fakeProvider(['1.1.1.1']);
      const consensus = fakeProvider(['9.9.9.9']);
      const tertiary = fakeProvider([]); // Partial

      const report = await validateRuntimeConsensusDisjointness(primary, consensus, tertiary, 'strict');

      expect(report.partial).toBe(true);
      expect(report.ok).toBe(false);
      expect(report.runtimeDegraded).toBe(true);
    });

    it('permissive mode with tertiary: passes even if tertiary is partial', async () => {
      const primary = fakeProvider(['1.1.1.1']);
      const consensus = fakeProvider(['9.9.9.9']);
      const tertiary = fakeProvider([]); // Partial

      const report = await validateRuntimeConsensusDisjointness(primary, consensus, tertiary, 'permissive');

      expect(report.partial).toBe(true);
      expect(report.ok).toBe(true); // No overlap, gate enabled
      expect(report.runtimeDegraded).toBe(false);
    });

    it('strict mode: still detects actual overlap and vetoes (ok=false, runtimeDegraded=false)', async () => {
      const primary = fakeProvider(['1.1.1.1']);
      const consensus = fakeProvider(['1.1.1.1']); // Actual overlap

      const report = await validateRuntimeConsensusDisjointness(primary, consensus, undefined, 'strict');

      expect(report.ok).toBe(false);
      expect(report.overlapIPs).toContain('1.1.1.1');
      expect(report.runtimeDegraded).toBe(false); // This is overlap, not partial
      expect(report.reason).toContain('overlap detected');
    });
  });
});
