import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RdapConfirmationStage } from '../rdap-confirmation-stage.js';
import { DomainStatus } from '../../../types/domain-status.js';
import type { RdapProvider } from '../../../providers/rdap/rdap-provider.js';
import type { WhoisProvider } from '../../../providers/whois/whois-provider.js';
import type { DomainCandidate } from '../../../types/candidate.js';
import { CandidateSource, CandidateStatus } from '../../../types/candidate.js';

function makeCandidate(domain: string, overrides?: Partial<DomainCandidate>): DomainCandidate {
  const tld = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '.com';
  return {
    domain,
    tld,
    source: CandidateSource.KeywordCombo,
    status: CandidateStatus.Pending,
    isPremium: false,
    pipelineRunId: 'test',
    ...overrides,
  };
}

function makeMockRdap(
  domain: string,
  status: DomainStatus = DomainStatus.Available,
  isPremium = false,
): RdapProvider {
  return {
    name: 'mock-rdap',
    confirm: vi.fn().mockResolvedValue({
      domain,
      status,
      isPremium,
      checkedAt: new Date().toISOString(),
    }),
  };
}

function makeMockWhois(available: boolean): WhoisProvider {
  return {
    checkAvailability: vi.fn().mockResolvedValue({
      domain: 'x',
      available,
      checkedAt: new Date().toISOString(),
    }),
  };
}

describe('RdapConfirmationStage (RDAP-only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes an available non-premium domain', async () => {
    const rdap = makeMockRdap('x.com');
    const stage = new RdapConfirmationStage(rdap);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(0);
  });

  it('filters a registered domain', async () => {
    const rdap = makeMockRdap('x.com', DomainStatus.Registered);
    const stage = new RdapConfirmationStage(rdap);
    const result = await stage.process([makeCandidate('taken.com')]);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
  });

  it('filters a premium domain', async () => {
    const rdap = makeMockRdap('x.com', DomainStatus.Available, true);
    const stage = new RdapConfirmationStage(rdap);
    const result = await stage.process([makeCandidate('premium.com')]);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
  });

  it('filters domains on RDAP error', async () => {
    const rdap: RdapProvider = {
      name: 'mock-rdap',
      confirm: vi.fn().mockRejectedValue(new Error('RDAP timeout')),
    };
    const stage = new RdapConfirmationStage(rdap);
    const result = await stage.process([makeCandidate('error.com')]);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.rdapStatus).toBe('error');
  });
});

describe('RdapConfirmationStage (RDAP + WHOIS parallel fallback)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefers RDAP result when both RDAP and WHOIS succeed', async () => {
    const rdap: RdapProvider = {
      name: 'mock-rdap',
      confirm: vi.fn().mockResolvedValue({
        domain: 'example.com',
        status: DomainStatus.Available,
        isPremium: false,
        registrar: 'GoDaddy',
        checkedAt: new Date().toISOString(),
      }),
    };
    const whois = makeMockWhois(true);
    const stage = new RdapConfirmationStage(rdap, whois);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.passed).toHaveLength(1);
    expect(rdap.confirm).toHaveBeenCalled();
  });

  it('falls back to WHOIS when RDAP fails', async () => {
    const rdap: RdapProvider = {
      name: 'mock-rdap',
      confirm: vi.fn().mockRejectedValue(new Error('RDAP timeout')),
    };
    const whois = makeMockWhois(true);
    const stage = new RdapConfirmationStage(rdap, whois);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(0);
  });

  it('filters domain when WHOIS says registered', async () => {
    const rdap: RdapProvider = {
      name: 'mock-rdap',
      confirm: vi.fn().mockRejectedValue(new Error('RDAP timeout')),
    };
    const whois = makeMockWhois(false);
    const stage = new RdapConfirmationStage(rdap, whois);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
  });

  it('filters domain when both RDAP and WHOIS fail', async () => {
    const rdap: RdapProvider = {
      name: 'mock-rdap',
      confirm: vi.fn().mockRejectedValue(new Error('RDAP timeout')),
    };
    const whois: WhoisProvider = {
      checkAvailability: vi.fn().mockRejectedValue(new Error('WHOIS timeout')),
    };
    const stage = new RdapConfirmationStage(rdap, whois);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
  });
});

describe('RdapConfirmationStage (WHOIS enrichment)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const sharedRdapAvailable: RdapProvider = {
    name: 'mock-rdap',
    confirm: vi.fn().mockResolvedValue({
      domain: 'x.com',
      status: DomainStatus.Available,
      isPremium: false,
      registrar: 'RDAP Registrar',
      expiresAt: '2026-06-01T00:00:00.000Z',
      checkedAt: new Date().toISOString(),
    }),
  };

  function makeEnrichWhois(
    overrides?: Partial<{
      createdDate: string | undefined;
      registrar: string | undefined;
      expiryDate: string | undefined;
      available: boolean;
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

  it('enriches a candidate with whoisMeta when WHOIS has creation date', async () => {
    const whois = makeEnrichWhois({
      createdDate: '2020-01-15T00:00:00.000Z',
      registrar: 'Test Registrar Inc.',
      expiryDate: '2026-01-15T00:00:00.000Z',
    });
    const stage = new RdapConfirmationStage(sharedRdapAvailable, whois, 5);
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

  it('skips WHOIS enrichment for closeout candidates that already have domainAge', async () => {
    const whois = makeEnrichWhois({ createdDate: '2015-01-01T00:00:00.000Z' });
    const stage = new RdapConfirmationStage(sharedRdapAvailable, whois, 5);
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
    const whois = makeEnrichWhois({ createdDate: '2018-06-01T00:00:00.000Z' });
    const stage = new RdapConfirmationStage(sharedRdapAvailable, whois, 5);
    const result = await stage.process([
      makeCandidate('closeout-no-meta.com', { source: CandidateSource.CloseoutCsv }),
    ]);

    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]!.whoisMeta).toBeDefined();
    expect(result.passed[0]!.whoisMeta!.domainAge).toBeGreaterThan(0);
  });

  it('falls back to RDAP-provided enrichment data when WHOIS returns no dates', async () => {
    const whois = makeEnrichWhois({});
    const stage = new RdapConfirmationStage(sharedRdapAvailable, whois, 5);
    const result = await stage.process([makeCandidate('nodata.com')]);

    expect(result.passed).toHaveLength(1);
    // RDAP provides registrar + expiresAt enrichment even when WHOIS has no dates
    expect(result.passed[0]!.whoisMeta).toBeDefined();
    expect(result.passed[0]!.whoisMeta!.registrar).toBe('RDAP Registrar');
    expect(result.passed[0]!.whoisMeta!.expiryDate).toBe('2026-06-01T00:00:00.000Z');
    // domainAge requires WHOIS createdDate — unavailable here
    expect(result.passed[0]!.whoisMeta!.domainAge).toBeUndefined();
  });

  it('handles WHOIS failure gracefully without blocking pipeline', async () => {
    const whois: WhoisProvider = {
      checkAvailability: vi.fn().mockRejectedValue(new Error('WHOIS timeout')),
    };
    const rdap = sharedRdapAvailable;
    const stage = new RdapConfirmationStage(rdap, whois, 5);
    const result = await stage.process([makeCandidate('timeout.com')]);

    expect(result.passed).toHaveLength(1);
    // RDAP succeeded and provides registrar + expiresAt enrichment
    expect(result.passed[0]!.whoisMeta).toBeDefined();
    expect(result.passed[0]!.whoisMeta!.registrar).toBe('RDAP Registrar');
    expect(result.passed[0]!.whoisMeta!.expiryDate).toBe('2026-06-01T00:00:00.000Z');
    // domainAge is only available from WHOIS createdDate
    expect(result.passed[0]!.whoisMeta!.domainAge).toBeUndefined();
  });

  it('enriches multiple candidates concurrently', async () => {
    const whois = makeEnrichWhois({
      createdDate: '2019-03-10T00:00:00.000Z',
      registrar: 'Test Registrar Inc.',
    });
    const stage = new RdapConfirmationStage(sharedRdapAvailable, whois, 5);
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

  it('preserves existing whoisMeta when RDAP enriches after earlier stage', async () => {
    const whois = makeEnrichWhois({ createdDate: '2019-03-10T00:00:00.000Z' });
    const stage = new RdapConfirmationStage(sharedRdapAvailable, whois, 5);
    const preEnriched = makeCandidate('partial.com', {
      whoisMeta: { registrar: 'Pre-registrar' },
    });
    const result = await stage.process([preEnriched]);

    expect(result.passed).toHaveLength(1);
    // Pre-existing registrar is preserved; new domainAge is added
    expect(result.passed[0]!.whoisMeta).toBeDefined();
    expect(result.passed[0]!.whoisMeta!.registrar).toBe('Pre-registrar');
    expect(result.passed[0]!.whoisMeta!.domainAge).toBeGreaterThan(0);
  });
});
