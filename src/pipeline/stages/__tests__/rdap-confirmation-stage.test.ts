// SPDX-License-Identifier: AGPL-3.0-only
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
    expect(result.passed[0]!.whoisMeta).toBeDefined();
    expect(result.passed[0]!.whoisMeta!.domainAge).toBe(10);
    expect(result.passed[0]!.whoisMeta!.createdDate).toBe('2015-01-01T00:00:00.000Z');
    expect(result.passed[0]!.whoisMeta!.registrar).toBe('RDAP Registrar');
    expect(result.passed[0]!.whoisMeta!.expiryDate).toBe('2026-06-01T00:00:00.000Z');
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

describe('RdapConfirmationStage (fresh provider for closeouts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes closeout candidates through the fresh (cache-bypassing) provider', async () => {
    const cachedConfirm = vi.fn().mockResolvedValue({
      domain: 'closeout.com',
      status: DomainStatus.Registered,
      isPremium: false,
      checkedAt: new Date().toISOString(),
    });
    const freshConfirm = vi.fn().mockResolvedValue({
      domain: 'closeout.com',
      status: DomainStatus.Available,
      isPremium: false,
      checkedAt: new Date().toISOString(),
    });
    const stage = new RdapConfirmationStage(
      { name: 'cached', confirm: cachedConfirm },
      undefined,
      5,
      10_000,
      1_000,
      { name: 'fresh', confirm: freshConfirm },
    );

    const result = await stage.process([
      makeCandidate('closeout.com', { source: CandidateSource.CloseoutCsv }),
    ]);

    expect(result.passed).toHaveLength(1);
    expect(freshConfirm).toHaveBeenCalledWith('closeout.com', expect.anything());
    expect(cachedConfirm).not.toHaveBeenCalled();
  });

  it('uses the cached provider for non-closeout candidates', async () => {
    const cachedConfirm = vi.fn().mockResolvedValue({
      domain: 'normal.com',
      status: DomainStatus.Available,
      isPremium: false,
      checkedAt: new Date().toISOString(),
    });
    const freshConfirm = vi.fn().mockResolvedValue({
      domain: 'normal.com',
      status: DomainStatus.Available,
      isPremium: false,
      checkedAt: new Date().toISOString(),
    });
    const stage = new RdapConfirmationStage(
      { name: 'cached', confirm: cachedConfirm },
      undefined,
      5,
      10_000,
      1_000,
      { name: 'fresh', confirm: freshConfirm },
    );

    const result = await stage.process([makeCandidate('normal.com')]);

    expect(result.passed).toHaveLength(1);
    expect(cachedConfirm).toHaveBeenCalled();
    expect(freshConfirm).not.toHaveBeenCalled();
  });

  it('falls back to the cached provider when no fresh provider is configured', async () => {
    const rdap = makeMockRdap('fallback.com');
    const stage = new RdapConfirmationStage(rdap);
    const result = await stage.process([
      makeCandidate('fallback.com', { source: CandidateSource.CloseoutCsv }),
    ]);
    expect(result.passed).toHaveLength(1);
    expect(rdap.confirm).toHaveBeenCalled();
  });

  it('routes closeout candidates through the fresh provider under WHOIS cross-validation', async () => {
    const freshConfirm = vi.fn().mockResolvedValue({
      domain: 'cv.com',
      status: DomainStatus.Available,
      isPremium: false,
      checkedAt: new Date().toISOString(),
    });
    const stage = new RdapConfirmationStage(
      { name: 'cached', confirm: vi.fn() },
      makeMockWhois(true),
      5,
      10_000,
      1_000,
      { name: 'fresh', confirm: freshConfirm },
    );

    const result = await stage.process([
      makeCandidate('cv.com', { source: CandidateSource.CloseoutCsv }),
    ]);

    expect(result.passed).toHaveLength(1);
    expect(freshConfirm).toHaveBeenCalled();
  });
});

describe('RdapConfirmationStage (WHOIS budget)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats RDAP as authoritative when WHOIS exceeds its budget (slow disagreement ignored)', async () => {
    // Arrange — RDAP says Available, WHOIS would say Registered but only after
    // 300ms: with a 100ms budget the WHOIS answer must be discarded and RDAP
    // decides (ADR-0035: RDAP is authoritative)
    const rdap: RdapProvider = {
      name: 'mock-rdap',
      confirm: vi.fn().mockResolvedValue({
        domain: 'example.com',
        status: DomainStatus.Available,
        isPremium: false,
        checkedAt: new Date().toISOString(),
      }),
    };
    const slowWhois: WhoisProvider = {
      checkAvailability: vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ domain: 'x', available: false, checkedAt: '' }), 300),
            ),
        ),
    };
    const stage = new RdapConfirmationStage(rdap, slowWhois, 5, 10_000, 100);

    // Act
    const result = await stage.process([makeCandidate('example.com')]);

    // Assert — RDAP wins; the candidate passes
    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(0);
    expect(rdap.confirm).toHaveBeenCalled();
  });

  it('still blocks on cross-validation disagreement when WHOIS answers within budget', async () => {
    // Arrange — WHOIS answers instantly, within the 100ms budget: the
    // disagreement must still be treated conservatively (filter as registered)
    const rdap: RdapProvider = {
      name: 'mock-rdap',
      confirm: vi.fn().mockResolvedValue({
        domain: 'example.com',
        status: DomainStatus.Available,
        isPremium: false,
        checkedAt: new Date().toISOString(),
      }),
    };
    const fastWhois: WhoisProvider = {
      checkAvailability: vi.fn().mockResolvedValue({
        domain: 'x',
        available: false,
        checkedAt: new Date().toISOString(),
      }),
    };
    const stage = new RdapConfirmationStage(rdap, fastWhois, 5, 10_000, 100);

    // Act
    const result = await stage.process([makeCandidate('example.com')]);

    // Assert — conservative filter wins
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]!.rdapStatus).toBe(DomainStatus.Registered);
  });
});

describe('RdapConfirmationStage 2-of-2 consensus (ADR-0050)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Secondary provider answering per-domain: Available, Registered (veto),
   *  or throwing (unverifiable). */
  function makeSecondary(statusByDomain: Record<string, DomainStatus>): RdapProvider {
    return {
      name: 'consensus-secondary',
      confirm: vi.fn().mockImplementation(async (domain: string) => {
        const status = statusByDomain[domain];
        if (status === undefined) throw new Error('secondary unverifiable');
        return {
          domain,
          status,
          isPremium: false,
          checkedAt: new Date().toISOString(),
        };
      }),
    };
  }

  function consensusStage(secondary: RdapProvider): RdapConfirmationStage {
    return new RdapConfirmationStage(
      makeMockRdap('primary.com'),
      undefined,
      10,
      10_000,
      1_000,
      undefined,
      {
        secondaryProvider: secondary,
        secondaryOrigin: 'https://secondary.example.com/',
      },
    );
  }

  it('passes an Available verdict only when the second provider confirms it', async () => {
    const secondary = makeSecondary({ 'confirm.com': DomainStatus.Available });
    const result = await consensusStage(secondary).process([makeCandidate('confirm.com')]);

    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(0);
    expect(secondary.confirm).toHaveBeenCalledWith('confirm.com', undefined);
    expect(result.rdapConsensusStats).toEqual({
      verified: 1,
      disagreed: 0,
      unverifiable: 0,
      degraded: false,
    });
  });

  it('vetoes on a definitive disagreement (secondary says Registered) — never Available', async () => {
    const secondary = makeSecondary({ 'veto.com': DomainStatus.Registered });
    const result = await consensusStage(secondary).process([makeCandidate('veto.com')]);

    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    // Fail-closed (ADR-0050): a vetoed candidate is downgraded to Unknown,
    // never Available — "registered wins" (ADR-0002).
    expect(result.filtered[0]!.rdapStatus).toBe(DomainStatus.Unknown);
    expect(result.filtered[0]!.status).toBe(CandidateStatus.RdapFiltered);
    expect(result.rdapConsensusStats!.disagreed).toBe(1);
  });

  it('downgrades to Unknown when the second provider cannot answer (fail-closed)', async () => {
    const secondary = makeSecondary({}); // throws for every domain
    const result = await consensusStage(secondary).process([makeCandidate('down.com')]);

    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]!.rdapStatus).toBe(DomainStatus.Unknown);
    expect(result.rdapConsensusStats!.unverifiable).toBe(1);
  });

  it('does not re-check candidates the primary leg already filtered', async () => {
    const secondary = makeSecondary({});
    const stage = new RdapConfirmationStage(
      makeMockRdap('taken.com', DomainStatus.Registered),
      undefined,
      10,
      10_000,
      1_000,
      undefined,
      { secondaryProvider: secondary, secondaryOrigin: 'https://secondary.example.com/' },
    );
    const result = await stage.process([makeCandidate('taken.com')]);

    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(secondary.confirm).not.toHaveBeenCalled();
  });

  it('reports stats when consensus ran with everything verified', async () => {
    const secondary = makeSecondary({
      'a.com': DomainStatus.Available,
      'b.com': DomainStatus.Available,
    });
    const stage = new RdapConfirmationStage(
      makeMockRdap('x.com'),
      undefined,
      10,
      10_000,
      1_000,
      undefined,
      { secondaryProvider: secondary, secondaryOrigin: 'https://secondary.example.com/' },
    );
    const result = await stage.process([makeCandidate('a.com'), makeCandidate('b.com')]);

    expect(result.passed).toHaveLength(2);
    expect(result.rdapConsensusStats).toEqual({
      verified: 2,
      disagreed: 0,
      unverifiable: 0,
      degraded: false,
    });
    expect(result.degradations).toBeUndefined();
  });

  it('omits consensus stats when the gate is not configured', async () => {
    const stage = new RdapConfirmationStage(makeMockRdap('x.com'));
    const result = await stage.process([makeCandidate('plain.com')]);
    expect(result.passed).toHaveLength(1);
    expect(result.rdapConsensusStats).toBeUndefined();
  });

  it('flags the run degraded when the secondary cannot verify most Available domains (ADR-0039)', async () => {
    const secondary = makeSecondary({ 'ok.com': DomainStatus.Available });
    const stage = new RdapConfirmationStage(
      makeMockRdap('x.com'),
      undefined,
      10,
      10_000,
      1_000,
      undefined,
      {
        secondaryProvider: secondary,
        secondaryOrigin: 'https://secondary.example.com/',
        degradedMin: 4,
      },
    );
    // 1 verified, 3 unverifiable → 75% unverified ≥ 0.5 ratio, ≥ degradedMin 4
    const result = await stage.process([
      makeCandidate('ok.com'),
      makeCandidate('d1.com'),
      makeCandidate('d2.com'),
      makeCandidate('d3.com'),
    ]);

    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(3);
    expect(result.rdapConsensusStats!.degraded).toBe(true);
    expect(result.degradations).toHaveLength(1);
    expect(result.degradations![0]!.reason).toBe('consensus-unverified');
    expect(result.degradations![0]!.message).toContain('3/4');
  });

  it('never flags small runs degraded (degradedMin protects sample size)', async () => {
    const secondary = makeSecondary({});
    const stage = consensusStage(secondary);
    const result = await stage.process([makeCandidate('d1.com'), makeCandidate('d2.com')]);

    expect(result.passed).toHaveLength(0);
    expect(result.rdapConsensusStats!.degraded).toBe(false);
    expect(result.degradations).toBeUndefined();
  });

  it('bounds verification parallelism with consensusConcurrency', async () => {
    let active = 0;
    let peak = 0;
    const secondary: RdapProvider = {
      name: 'consensus-secondary',
      confirm: vi.fn().mockImplementation(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return {
          domain: 'x.com',
          status: DomainStatus.Available,
          isPremium: false,
          checkedAt: new Date().toISOString(),
        };
      }),
    };
    const stage = new RdapConfirmationStage(
      makeMockRdap('x.com'),
      undefined,
      10,
      10_000,
      1_000,
      undefined,
      {
        secondaryProvider: secondary,
        secondaryOrigin: 'https://secondary.example.com/',
        consensusConcurrency: 2,
      },
    );
    const result = await stage.process([
      makeCandidate('c1.com'),
      makeCandidate('c2.com'),
      makeCandidate('c3.com'),
      makeCandidate('c4.com'),
    ]);

    expect(result.passed).toHaveLength(4);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
