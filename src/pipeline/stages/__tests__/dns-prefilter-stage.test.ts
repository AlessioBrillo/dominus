import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DnsPreFilterStage } from '../dns-prefilter-stage.js';
import { DomainStatus } from '../../../types/domain-status.js';
import { CandidateSource, CandidateStatus } from '../../../types/candidate.js';
import type { DomainCandidate } from '../../../types/candidate.js';
import type { DnsProvider } from '../../../providers/dns/dns-provider.js';

function makeCandidate(domain: string): DomainCandidate {
  return {
    domain,
    tld: '.com',
    source: CandidateSource.KeywordCombo,
    status: CandidateStatus.Pending,
    isPremium: false,
    pipelineRunId: 'test',
  };
}

function makeMockDns(results: DomainStatus[]): DnsProvider {
  return {
    name: 'MockDns',
    checkAvailability: vi.fn(),
    checkBulk: vi.fn().mockResolvedValue(
      results.map((status) => ({
        domain: 'x',
        status,
        checkedAt: new Date().toISOString(),
      })),
    ),
    clearCache: vi.fn(),
  };
}

describe('DnsPreFilterStage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes an available domain', async () => {
    const dns = makeMockDns([DomainStatus.Available]);
    const stage = new DnsPreFilterStage(dns);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(0);
    expect(result.passed[0]?.dnsStatus).toBe(DomainStatus.Available);
  });

  it('passes an unknown-status domain', async () => {
    const dns = makeMockDns([DomainStatus.Unknown]);
    const stage = new DnsPreFilterStage(dns);
    const result = await stage.process([makeCandidate('unknown.com')]);
    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(0);
    expect(result.passed[0]?.dnsStatus).toBe(DomainStatus.Unknown);
  });

  it('filters a registered domain', async () => {
    const dns = makeMockDns([DomainStatus.Registered]);
    const stage = new DnsPreFilterStage(dns);
    const result = await stage.process([makeCandidate('taken.com')]);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.status).toBe(CandidateStatus.DnsFiltered);
  });

  it('filters a premium domain', async () => {
    const dns = makeMockDns([DomainStatus.Premium]);
    const stage = new DnsPreFilterStage(dns);
    const result = await stage.process([makeCandidate('premium.com')]);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.status).toBe(CandidateStatus.DnsFiltered);
  });

  it('filters an errored domain', async () => {
    const dns = makeMockDns([DomainStatus.Error]);
    const stage = new DnsPreFilterStage(dns);
    const result = await stage.process([makeCandidate('error.com')]);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.status).toBe(CandidateStatus.DnsFiltered);
  });

  it('handles mixed results and filters only registered/premium/error', async () => {
    const dns = makeMockDns([
      DomainStatus.Available,
      DomainStatus.Registered,
      DomainStatus.Unknown,
      DomainStatus.Premium,
    ]);
    const stage = new DnsPreFilterStage(dns);
    const candidates = [
      makeCandidate('good.com'),
      makeCandidate('taken.com'),
      makeCandidate('unknown.com'),
      makeCandidate('premium.com'),
    ];
    const result = await stage.process(candidates);
    expect(result.passed).toHaveLength(2);
    expect(result.filtered).toHaveLength(2);
  });

  it('sets stage name and duration', async () => {
    const dns = makeMockDns([DomainStatus.Available]);
    const stage = new DnsPreFilterStage(dns);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.stageName).toBe('DnsPreFilterStage');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
