// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectResolverEndpoints, strategyToResolverGroups } from '../dns-provider.js';
import {
  validateConsensusEndpointDisjointness,
  validateConsensusStrategyDisjointness,
  validateResolverGroups,
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

describe('validateConsensusStrategyDisjointness', () => {
  it('accepts disjoint strategies when enabled', () => {
    expect(validateConsensusStrategyDisjointness(true, 'doh-primary', 'dot-only')).toBe(true);
  });

  it('rejects identical strategies when enabled', () => {
    expect(validateConsensusStrategyDisjointness(true, 'dot-only', 'dot-only')).toBe(false);
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
