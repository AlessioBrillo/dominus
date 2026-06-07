import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RdapProvider } from '../../../providers/rdap/rdap-provider.js';
import type { WhoisProvider } from '../../../providers/whois/whois-provider.js';
import { RdapConfirmationStage } from '../rdap-confirmation-stage.js';
import { DomainStatus } from '../../../types/domain-status.js';
import { CandidateSource, CandidateStatus } from '../../../types/candidate.js';
import type { DomainCandidate } from '../../../types/candidate.js';

function makeCandidate(domain: string): DomainCandidate {
  const tld = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '.com';
  return {
    id: 0,
    domain,
    tld,
    source: CandidateSource.CloseoutCsv,
    status: CandidateStatus.DnsFiltered,
    isPremium: false,
    pipelineRunId: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeRdap(available: boolean, error?: Error): RdapProvider {
  return {
    confirm: error
      ? vi.fn().mockRejectedValue(error)
      : vi.fn().mockResolvedValue({
          domain: 'example.com',
          status: available ? DomainStatus.Available : DomainStatus.Registered,
          isPremium: false,
          registrar: available ? undefined : 'GoDaddy',
          checkedAt: new Date().toISOString(),
        }),
  };
}

function makeWhois(available: boolean, error?: Error): WhoisProvider {
  return {
    checkAvailability: error
      ? vi.fn().mockRejectedValue(error)
      : vi.fn().mockResolvedValue({
          domain: 'example.com',
          available,
          checkedAt: new Date().toISOString(),
        }),
  };
}

describe('RdapConfirmationStage — integration (RDAP + WHOIS parallel fallback)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('RDAP alone works when WHOIS is not provided', async () => {
    const rdap = makeRdap(true);
    const stage = new RdapConfirmationStage(rdap);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.passed).toHaveLength(1);
  });

  it('RDAP alone filters when domain is registered', async () => {
    const rdap = makeRdap(false);
    const stage = new RdapConfirmationStage(rdap);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.filtered).toHaveLength(1);
  });

  it('parallel: both RDAP and WHOIS fire, RDAP result wins', async () => {
    const rdap = makeRdap(true);
    const whois = makeWhois(false);
    const stage = new RdapConfirmationStage(rdap, whois);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.passed).toHaveLength(1);
    expect(rdap.confirm).toHaveBeenCalled();
    expect(whois.checkAvailability).toHaveBeenCalled();
  });

  it('parallel: WHOIS fallback when RDAP fails and WHOIS says available', async () => {
    const rdap = makeRdap(false, new Error('RDAP timeout'));
    const whois = makeWhois(true);
    const stage = new RdapConfirmationStage(rdap, whois);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(0);
  });

  it('parallel: filters when both RDAP and WHOIS say registered', async () => {
    const rdap = makeRdap(false);
    const whois = makeWhois(false);
    const stage = new RdapConfirmationStage(rdap, whois);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.filtered).toHaveLength(1);
  });

  it('parallel: filters when both RDAP and WHOIS fail entirely', async () => {
    const rdap = makeRdap(false, new Error('RDAP timeout'));
    const whois = makeWhois(true, new Error('WHOIS timeout'));
    const stage = new RdapConfirmationStage(rdap, whois);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.filtered).toHaveLength(1);
  });

  it('parallel: RDAP premium domains go to filtered (not passed)', async () => {
    const rdap: RdapProvider = {
      confirm: vi.fn().mockResolvedValue({
        domain: 'example.com',
        status: DomainStatus.Available,
        isPremium: true,
        premiumPrice: 2500,
        registrar: undefined,
        checkedAt: new Date().toISOString(),
      }),
    };
    const whois = makeWhois(false);
    const stage = new RdapConfirmationStage(rdap, whois);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.isPremium).toBe(true);
  });

  it('parallel: multiple candidates processed concurrently', async () => {
    const rdap = makeRdap(true);
    const whois = makeWhois(true);
    const stage = new RdapConfirmationStage(rdap, whois);
    const result = await stage.process([
      makeCandidate('alpha.com'),
      makeCandidate('beta.com'),
      makeCandidate('gamma.com'),
    ]);
    expect(result.passed).toHaveLength(3);
    expect(result.filtered).toHaveLength(0);
  });
});
