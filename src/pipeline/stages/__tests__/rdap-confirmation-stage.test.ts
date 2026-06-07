import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RdapConfirmationStage } from '../rdap-confirmation-stage.js';
import { DomainStatus } from '../../../types/domain-status.js';
import type { RdapProvider } from '../../../providers/rdap/rdap-provider.js';
import type { WhoisProvider } from '../../../providers/whois/whois-provider.js';
import type { DomainCandidate } from '../../../types/candidate.js';
import { CandidateSource, CandidateStatus } from '../../../types/candidate.js';

function makeCandidate(domain: string): DomainCandidate {
  const tld = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '.com';
  return { domain, tld, source: CandidateSource.KeywordCombo, status: CandidateStatus.Pending, isPremium: false, pipelineRunId: 'test' };
}

function makeMockRdap(
  domain: string,
  status: DomainStatus = DomainStatus.Available,
  isPremium = false,
): RdapProvider {
  return {
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
