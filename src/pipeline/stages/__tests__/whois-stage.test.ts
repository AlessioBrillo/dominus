import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhoisStage } from '../whois-stage.js';
import { CandidateSource, CandidateStatus } from '../../../types/candidate.js';
import type { DomainCandidate } from '../../../types/candidate.js';
import type { WhoisProvider } from '../../../providers/whois/whois-provider.js';

function makeCandidate(domain: string, overrides?: Partial<DomainCandidate>): DomainCandidate {
  return {
    domain,
    tld: '.com',
    source: CandidateSource.KeywordCombo,
    status: CandidateStatus.Pending,
    isPremium: false,
    pipelineRunId: 'test',
    ...overrides,
  };
}

function makeMockWhois(
  overrides?: Partial<{
    available: boolean;
    createdDate: string | undefined;
    registrar: string | undefined;
    expiryDate: string | undefined;
  }>,
): WhoisProvider {
  return {
    checkAvailability: vi.fn().mockResolvedValue({
      domain: 'x',
      available: overrides?.available ?? true,
      createdDate: overrides?.createdDate,
      registrar: overrides?.registrar,
      expiryDate: overrides?.expiryDate,
      checkedAt: new Date().toISOString(),
    }),
  };
}

describe('WhoisStage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enriches a keyword candidate with whoisMeta when WHOIS has data', async () => {
    const whois = makeMockWhois({
      createdDate: '2020-01-15T00:00:00.000Z',
      registrar: 'Test Registrar Inc.',
      expiryDate: '2026-01-15T00:00:00.000Z',
    });
    const stage = new WhoisStage(whois, 5);
    const result = await stage.process([makeCandidate('example.com')]);

    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(0);
    const enriched = result.passed[0]!;
    expect(enriched.whoisMeta).toBeDefined();
    expect(enriched.whoisMeta!.domainAge).toBeGreaterThan(0);
    expect(enriched.whoisMeta!.registrar).toBe('Test Registrar Inc.');
    expect(enriched.whoisMeta!.createdDate).toBe('2020-01-15T00:00:00.000Z');
    expect(enriched.whoisMeta!.expiryDate).toBe('2026-01-15T00:00:00.000Z');
  });

  it('skips WHOIS lookup for closeout candidates that already have domainAge', async () => {
    const whois = makeMockWhois({ createdDate: '2015-01-01T00:00:00.000Z' });
    const stage = new WhoisStage(whois, 5);
    const result = await stage.process([
      makeCandidate('closeout.com', {
        source: CandidateSource.CloseoutCsv,
        closeoutMeta: { domainAge: 10, backlinks: 50, waybackSnapshots: 100 },
      }),
    ]);

    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]!.whoisMeta).toBeUndefined();
  });

  it('still enriches closeout candidates that lack closeoutMeta', async () => {
    const whois = makeMockWhois({ createdDate: '2018-06-01T00:00:00.000Z' });
    const stage = new WhoisStage(whois, 5);
    const result = await stage.process([
      makeCandidate('closeout-no-meta.com', { source: CandidateSource.CloseoutCsv }),
    ]);

    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]!.whoisMeta).toBeDefined();
    expect(result.passed[0]!.whoisMeta!.domainAge).toBeGreaterThan(0);
  });

  it('produces undefined whoisMeta when WHOIS returns no dates', async () => {
    const whois = makeMockWhois({});
    const stage = new WhoisStage(whois, 5);
    const result = await stage.process([makeCandidate('nodata.com')]);

    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]!.whoisMeta).toBeUndefined();
  });

  it('handles WHOIS failure gracefully without blocking pipeline', async () => {
    const whois: WhoisProvider = {
      checkAvailability: vi.fn().mockRejectedValue(new Error('WHOIS timeout')),
    };
    const stage = new WhoisStage(whois, 5);
    const result = await stage.process([makeCandidate('timeout.com')]);

    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]!.whoisMeta).toBeUndefined();
  });

  it('enriches multiple candidates concurrently', async () => {
    const whois = makeMockWhois({
      createdDate: '2019-03-10T00:00:00.000Z',
      registrar: 'Test Registrar Inc.',
    });
    const stage = new WhoisStage(whois, 5);
    const candidates = [
      makeCandidate('alpha.com'),
      makeCandidate('beta.com'),
      makeCandidate('gamma.com'),
    ];
    const result = await stage.process(candidates);

    expect(result.passed).toHaveLength(3);
    for (const c of result.passed) {
      expect(c.whoisMeta).toBeDefined();
      expect(c.whoisMeta!.registrar).toBe('Test Registrar Inc.');
    }
  });

  it('sets stage name and duration', async () => {
    const whois = makeMockWhois({});
    const stage = new WhoisStage(whois, 5);
    const result = await stage.process([makeCandidate('example.com')]);

    expect(result.stageName).toBe('WhoisStage');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
