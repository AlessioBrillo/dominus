// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { DnsPreFilterStage } from '../dns-prefilter-stage.js';
import type { DnsProvider } from '../../../providers/dns/dns-provider.js';
import { DomainStatus, type DnsCheckResult } from '../../../types/domain-status.js';
import { CandidateStatus, CandidateSource } from '../../../types/candidate.js';
import { createMockCandidate } from './test-helpers.js';

const mockDnsProvider = (domain: string, checkResult: DnsCheckResult): DnsProvider => ({
  name: 'mock',
  checkAvailability: vi.fn().mockImplementation(async (d: string) => {
    await Promise.resolve();
    return d.slice(-domain.length) === domain
      ? checkResult
      : { domain: d, status: DomainStatus.Unknown, checkedAt: '' };
  }),
  clearCache: vi.fn(),
  pruneCache: vi.fn().mockReturnValue(0),
  checkBulk: async (domains: string[]) => domains.map(() => checkResult),
});

describe('DnsPreFilterStage', () => {
  it('filters invalid domain names', async () => {
    const provider = mockDnsProvider('', {
      domain: '',
      status: DomainStatus.Available,
      checkedAt: '',
    });
    const stage = new DnsPreFilterStage(provider);
    const candidates = [createMockCandidate({ domain: 'invalid-.com' })];
    const result = await stage.process(candidates);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]!.dnsStatus).toBe('invalid');
    expect(result.filtered[0]!.status).toBe(CandidateStatus.DnsFiltered);
  });

  it('passes through domains that are Available', async () => {
    const provider = mockDnsProvider('free.io', {
      domain: 'free.io',
      status: DomainStatus.Available,
      checkedAt: '',
    });
    const stage = new DnsPreFilterStage(provider);
    const candidates = [createMockCandidate({ domain: 'free.io' })];
    const result = await stage.process(candidates);
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]!.domain).toBe('free.io');
    expect(result.passed[0]!.dnsStatus).toBe('available');
  });

  it('filters domains that are Registered', async () => {
    const provider = mockDnsProvider('taken.com', {
      domain: 'taken.com',
      status: DomainStatus.Registered,
      checkedAt: '',
    });
    const stage = new DnsPreFilterStage(provider);
    const candidates = [createMockCandidate({ domain: 'taken.com' })];
    const result = await stage.process(candidates);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]!.dnsStatus).toBe('registered');
    expect(result.filtered[0]!.status).toBe(CandidateStatus.DnsFiltered);
  });

  it('filters domains with Unknown status', async () => {
    const provider = mockDnsProvider('unknown.io', {
      domain: 'unknown.io',
      status: DomainStatus.Unknown,
      checkedAt: '',
    });
    const stage = new DnsPreFilterStage(provider);
    const candidates = [createMockCandidate({ domain: 'unknown.io' })];
    const result = await stage.process(candidates);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]!.dnsStatus).toBe('unknown');
    expect(result.filtered[0]!.status).toBe(CandidateStatus.DnsFiltered);
  });

  it('passes parked domains when parking check is enabled', async () => {
    const provider = mockDnsProvider('parked.io', {
      domain: 'parked.io',
      status: DomainStatus.Registered,
      checkedAt: '',
      isParked: true,
      parkingRegistrar: 'GoDaddy',
    });
    const stage = new DnsPreFilterStage(provider);
    const candidates = [createMockCandidate({ domain: 'parked.io' })];
    const result = await stage.process(candidates);
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]!.dnsStatus).toBe('parked');
    expect(result.passed[0]!.status).toBe(CandidateStatus.Pending);
    expect(result.passed[0]!.whoisMeta?.registrar).toBe('GoDaddy');
  });

  it('skips sources configured in skipSources', async () => {
    const provider = mockDnsProvider('skip.io', {
      domain: 'skip.io',
      status: DomainStatus.Registered,
      checkedAt: '',
    });
    const stage = new DnsPreFilterStage(provider, 10, [CandidateSource.CloseoutCsv]);
    const candidates = [
      createMockCandidate({ domain: 'skip.io', source: CandidateSource.CloseoutCsv }),
      createMockCandidate({ domain: 'check.io', source: CandidateSource.KeywordCombo }),
    ];
    const result = await stage.process(candidates);
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]!.domain).toBe('skip.io');
    expect(result.passed[0]!.dnsStatus).toBe('skipped');
    expect(result.passed[0]!.status).toBe(CandidateStatus.Pending);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]!.domain).toBe('check.io');
  });

  it('uses forceRecheck for closeout CSV candidates', async () => {
    const checkAvailability = vi.fn().mockResolvedValue({
      domain: 'closeout.io',
      status: DomainStatus.Available,
      checkedAt: '',
    });
    const provider: DnsProvider = {
      name: 'mock',
      checkAvailability,
      checkBulk: vi.fn().mockRejectedValue(new Error('bulk check failed')),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const stage = new DnsPreFilterStage(provider);
    const candidates = [
      createMockCandidate({ domain: 'closeout.io', source: CandidateSource.CloseoutCsv }),
    ];
    await stage.process(candidates);
    expect(checkAvailability).toHaveBeenCalledWith('closeout.io', undefined, {
      forceRecheck: true,
    });
  });

  it('propagates forceWhoisRecheck for closeout candidates', async () => {
    const provider = mockDnsProvider('closeout.io', {
      domain: 'closeout.io',
      status: DomainStatus.Available,
      checkedAt: '',
    });
    const stage = new DnsPreFilterStage(provider);
    const candidates = [
      createMockCandidate({ domain: 'closeout.io', source: CandidateSource.CloseoutCsv }),
    ];
    const result = await stage.process(candidates);
    expect(result.passed[0]!.forceWhoisRecheck).toBe(true);
  });

  it('uses bulk check when available', async () => {
    const checkBulk = vi.fn().mockResolvedValue([
      { domain: 'a.io', status: DomainStatus.Available, checkedAt: '' },
      { domain: 'b.io', status: DomainStatus.Registered, checkedAt: '' },
    ]);
    const provider: DnsProvider = {
      name: 'mock',
      checkAvailability: vi.fn(),
      checkBulk,
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const stage = new DnsPreFilterStage(provider);
    const candidates = [
      createMockCandidate({ domain: 'a.io' }),
      createMockCandidate({ domain: 'b.io' }),
    ];
    await stage.process(candidates);
    expect(checkBulk).toHaveBeenCalledTimes(1);
    expect(checkBulk.mock.calls[0]![0]).toEqual(['a.io', 'b.io']);
  });

  it('falls back to per-domain checks when bulk check throws', async () => {
    const checkAvailability = vi
      .fn()
      .mockResolvedValueOnce({ domain: 'a.io', status: DomainStatus.Available, checkedAt: '' })
      .mockResolvedValueOnce({ domain: 'b.io', status: DomainStatus.Registered, checkedAt: '' });
    const checkBulk = vi.fn().mockRejectedValue(new Error('bulk check failed'));
    const provider: DnsProvider = {
      name: 'mock',
      checkAvailability,
      checkBulk,
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const stage = new DnsPreFilterStage(provider);
    const candidates = [
      createMockCandidate({ domain: 'a.io' }),
      createMockCandidate({ domain: 'b.io' }),
    ];
    const result = await stage.process(candidates);
    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(1);
    expect(checkAvailability).toHaveBeenCalledTimes(2);
  });

  it('retries undefined results from bulk check', async () => {
    const checkBulk = vi
      .fn()
      .mockResolvedValue([
        { domain: 'a.io', status: DomainStatus.Available, checkedAt: '' },
        undefined,
        { domain: 'c.io', status: DomainStatus.Available, checkedAt: '' },
      ]);
    const checkAvailability = vi.fn().mockResolvedValue({
      domain: 'b.io',
      status: DomainStatus.Available,
      checkedAt: '',
    });
    const provider: DnsProvider = {
      name: 'mock',
      checkAvailability,
      checkBulk,
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const stage = new DnsPreFilterStage(provider);
    const candidates = [
      createMockCandidate({ domain: 'a.io' }),
      createMockCandidate({ domain: 'b.io' }),
      createMockCandidate({ domain: 'c.io' }),
    ];
    const result = await stage.process(candidates);
    expect(result.passed).toHaveLength(3);
    expect(checkAvailability).toHaveBeenCalledWith('b.io', undefined, undefined);
  });

  it('returns consensus stats from ConsensusDnsProvider', async () => {
    const provider = {
      name: 'ConsensusDnsProvider',
      checkAvailability: vi.fn().mockResolvedValue({
        domain: 'free.io',
        status: DomainStatus.Available,
        checkedAt: '',
      }),
      checkBulk: vi
        .fn()
        .mockResolvedValue([{ domain: 'free.io', status: DomainStatus.Available, checkedAt: '' }]),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
      getConsensusStats: vi.fn().mockReturnValue({
        verified: 1,
        disagreed: 0,
        unverifiable: 0,
        degraded: false,
        tertiaryRescued: 0,
      }),
    } as unknown as DnsProvider & {
      getConsensusStats: () => {
        verified: number;
        disagreed: number;
        unverifiable: number;
        degraded: boolean;
        tertiaryRescued: number;
      };
    };
    const stage = new DnsPreFilterStage(provider);
    const candidates = [createMockCandidate({ domain: 'free.io' })];
    const result = await stage.process(candidates);
    expect(result.consensusStats).toEqual({
      verified: 1,
      disagreed: 0,
      unverifiable: 0,
      degraded: false,
      tertiaryRescued: 0,
    });
  });
});
