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

  it('filters domains with Unknown status (fail-closed)', async () => {
    const provider = mockDnsProvider('unknown.net', {
      domain: 'unknown.net',
      status: DomainStatus.Unknown,
      checkedAt: '',
    });
    const stage = new DnsPreFilterStage(provider);
    const candidates = [createMockCandidate({ domain: 'unknown.net' })];
    const result = await stage.process(candidates);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]!.domain).toBe('unknown.net');
    expect(result.filtered[0]!.dnsStatus).toBe('unknown');
    expect(result.filtered[0]!.status).toBe(CandidateStatus.DnsFiltered);
  });

  it('filters registered domains to DnsFiltered', async () => {
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
  });

  it('passes through parked domains with dnsStatus=parked', async () => {
    const provider = mockDnsProvider('aftermarket.de', {
      domain: 'aftermarket.de',
      status: DomainStatus.Registered,
      isParked: true,
      parkingRegistrar: 'GoDaddy',
      checkedAt: '',
    });
    const stage = new DnsPreFilterStage(provider);
    const candidates = [createMockCandidate({ domain: 'aftermarket.de' })];
    const result = await stage.process(candidates);
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]!.domain).toBe('aftermarket.de');
    expect(result.passed[0]!.dnsStatus).toBe('parked');
    expect(result.passed[0]!.status).toBe(CandidateStatus.Pending);
  });

  it('filters registered domains without isParked flag', async () => {
    const provider = mockDnsProvider('real-site.com', {
      domain: 'real-site.com',
      status: DomainStatus.Registered,
      checkedAt: '',
    });
    const stage = new DnsPreFilterStage(provider);
    const candidates = [createMockCandidate({ domain: 'real-site.com' })];
    const result = await stage.process(candidates);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]!.dnsStatus).toBe('registered');
  });

  it('filters on error result', async () => {
    const provider = mockDnsProvider('broken.com', {
      domain: 'broken.com',
      status: DomainStatus.Registered,
      checkedAt: '',
    });
    const stage = new DnsPreFilterStage(provider);
    const candidates = [createMockCandidate({ domain: 'broken.com' })];
    const result = await stage.process(candidates);
    expect(result.filtered).toHaveLength(1);
  });

  it('skips candidates from skipSources with dnsStatus=skipped', async () => {
    const provider = mockDnsProvider('any.com', {
      domain: 'any.com',
      status: DomainStatus.Registered,
      checkedAt: '',
    });
    const stage = new DnsPreFilterStage(provider, 10, [CandidateSource.CloseoutCsv]);
    const candidate = createMockCandidate({
      domain: 'skip.com',
      source: CandidateSource.CloseoutCsv,
    });
    const result = await stage.process([candidate]);
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]!.dnsStatus).toBe('skipped');
  });

  it('aborts when signal is already aborted', async () => {
    const provider = mockDnsProvider('aborted.com', {
      domain: 'aborted.com',
      status: DomainStatus.Available,
      checkedAt: '',
    });
    const stage = new DnsPreFilterStage(provider);
    const ac = new AbortController();
    ac.abort();
    const candidate = createMockCandidate({ domain: 'aborted.com' });
    const result = await stage.process([candidate], ac.signal);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(0);
  });

  it('returns durationMs in result', async () => {
    const provider = mockDnsProvider('fast.io', {
      domain: 'fast.io',
      status: DomainStatus.Available,
      checkedAt: '',
    });
    const stage = new DnsPreFilterStage(provider);
    const result = await stage.process([createMockCandidate({ domain: 'fast.io' })]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('includes stageName in result', async () => {
    const provider = mockDnsProvider('any.io', {
      domain: 'any.io',
      status: DomainStatus.Available,
      checkedAt: '',
    });
    const stage = new DnsPreFilterStage(provider);
    const result = await stage.process([createMockCandidate({ domain: 'any.io' })]);
    expect(result.stageName).toBe('DnsPreFilterStage');
  });
});
