// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { DnsPreFilterStage, type ConsensusDnsConfig } from '../dns-prefilter-stage.js';
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

  it('passes forceRecheck:true for closeout CSV candidates via checkBulk', async () => {
    const checkBulk = vi
      .fn()
      .mockResolvedValue([
        { domain: 'closeout.com', status: DomainStatus.Available, checkedAt: '' },
      ]);
    const provider: DnsProvider = {
      name: 'mock',
      checkAvailability: vi.fn(),
      checkBulk,
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const stage = new DnsPreFilterStage(provider);
    const candidate = createMockCandidate({
      domain: 'closeout.com',
      source: CandidateSource.CloseoutCsv,
    });
    const result = await stage.process([candidate]);
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]!.domain).toBe('closeout.com');
    expect(checkBulk).toHaveBeenCalledWith(['closeout.com'], undefined, { forceRecheck: true });
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

// --- 2-of-3 consensus (strict ADR-0002 semantics) ---

/** Primary that reports every domain Available via checkBulk. */
function consensusPrimary(): DnsProvider {
  return {
    name: 'primary',
    checkAvailability: vi.fn(),
    checkBulk: vi.fn().mockResolvedValue([
      { domain: 'free.io', status: DomainStatus.Available, checkedAt: '' },
      { domain: 'maybe.io', status: DomainStatus.Available, checkedAt: '' },
      { domain: 'confirm.io', status: DomainStatus.Available, checkedAt: '' },
      { domain: 'reject.io', status: DomainStatus.Available, checkedAt: '' },
    ]),
    clearCache: vi.fn(),
    pruneCache: vi.fn().mockReturnValue(0),
  };
}

function consensusStage(secondary: DnsProvider): DnsPreFilterStage {
  const config: ConsensusDnsConfig = { secondaryProvider: secondary };
  return new DnsPreFilterStage(consensusPrimary(), 10, [], config);
}

const CONSENSUS_DOMAINS = ['free.io', 'maybe.io', 'confirm.io', 'reject.io'];

describe('DnsPreFilterStage consensus (strict)', () => {
  it('passes Available when the secondary confirms Available', async () => {
    const secondary: DnsProvider = {
      name: 'secondary',
      checkAvailability: vi.fn().mockResolvedValue({
        domain: 'x.io',
        status: DomainStatus.Available,
        checkedAt: '',
      }),
      checkBulk: vi.fn(),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const result = await consensusStage(secondary).process(
      CONSENSUS_DOMAINS.map((domain) => createMockCandidate({ domain })),
    );
    expect(result.passed.map((c) => c.domain).sort()).toEqual([...CONSENSUS_DOMAINS].sort());
    expect(result.filtered).toHaveLength(0);
  });

  it('downgrades to Unknown when the secondary returns Unknown', async () => {
    const secondary = mockDnsProvider('', {
      domain: '',
      status: DomainStatus.Unknown,
      checkedAt: '',
    });
    const result = await consensusStage(secondary).process(
      CONSENSUS_DOMAINS.map((domain) => createMockCandidate({ domain })),
    );
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(CONSENSUS_DOMAINS.length);
    for (const c of result.filtered) {
      expect(c.dnsStatus).toBe('unknown');
      expect(c.status).toBe(CandidateStatus.DnsFiltered);
    }
  });

  it('downgrades to Unknown when the secondary throws (no-answer)', async () => {
    const secondary: DnsProvider = {
      name: 'secondary-down',
      checkAvailability: vi.fn().mockRejectedValue(new Error('secondary unavailable')),
      checkBulk: vi.fn(),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const result = await consensusStage(secondary).process(
      CONSENSUS_DOMAINS.map((domain) => createMockCandidate({ domain })),
    );
    expect(result.passed).toHaveLength(0);
    for (const c of result.filtered) {
      expect(c.dnsStatus).toBe('unknown');
    }
  });

  it('downgrades to Unknown when the secondary disagrees (Registered)', async () => {
    const secondary = mockDnsProvider('', {
      domain: '',
      status: DomainStatus.Registered,
      checkedAt: '',
    });
    const result = await consensusStage(secondary).process(
      CONSENSUS_DOMAINS.map((domain) => createMockCandidate({ domain })),
    );
    expect(result.passed).toHaveLength(0);
    for (const c of result.filtered) {
      expect(c.dnsStatus).toBe('unknown');
    }
  });

  it('does not re-check Registered domains from the primary', async () => {
    const secondaryCheck = vi.fn().mockResolvedValue({
      domain: 'taken.com',
      status: DomainStatus.Available,
      checkedAt: '',
    });
    const primary: DnsProvider = {
      name: 'primary',
      checkAvailability: vi.fn(),
      checkBulk: vi.fn().mockResolvedValue([
        { domain: 'free.io', status: DomainStatus.Available, checkedAt: '' },
        { domain: 'taken.com', status: DomainStatus.Registered, checkedAt: '' },
      ]),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const secondary: DnsProvider = {
      name: 'secondary',
      checkAvailability: secondaryCheck,
      checkBulk: vi.fn(),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const stage = new DnsPreFilterStage(primary, 10, [], { secondaryProvider: secondary });
    const result = await stage.process([
      createMockCandidate({ domain: 'free.io' }),
      createMockCandidate({ domain: 'taken.com' }),
    ]);
    expect(result.passed.map((c) => c.domain)).toEqual(['free.io']);
    expect(result.filtered.map((c) => c.domain)).toEqual(['taken.com']);
    // Secondary queried only for the Available domain, never the Registered one.
    expect(secondaryCheck).toHaveBeenCalledTimes(1);
    expect(secondaryCheck.mock.calls[0]![0]).toBe('free.io');
  });
});

// --- Consensus degradation (consensus-unverified, ADR-0039) ---
//
// A strict 2-of-3 consensus that cannot verify a large share of the
// Available domains means the availability verdict is unreliable: the run
// probed forward with Unknown downgrades, which is fail-closed but produces
// degraded output. The stage must surface that as a degradation reason so
// runners are told the output is incomplete, not silently empty (ADR-0037).

function makeManyAvailablePrimary(domains: string[]): DnsProvider {
  return {
    name: 'primary',
    checkAvailability: vi.fn(),
    checkBulk: vi
      .fn()
      .mockResolvedValue(
        domains.map((d) => ({ domain: d, status: DomainStatus.Available, checkedAt: '' })),
      ),
    clearCache: vi.fn(),
    pruneCache: vi.fn().mockReturnValue(0),
  };
}

function makeDownSecondary(notes?: boolean): DnsProvider {
  return {
    name: 'secondary-down',
    checkAvailability: vi.fn().mockImplementation(async () => {
      if (notes) await Promise.resolve();
      throw new Error('secondary unreachable');
    }),
    checkBulk: vi.fn(),
    clearCache: vi.fn(),
    pruneCache: vi.fn().mockReturnValue(0),
  };
}

describe('DnsPreFilterStage consensus degradation (ADR-0039)', () => {
  it('reports a consensus-unverified degradation when the secondary cannot verify most domains', async () => {
    const domains = Array.from({ length: 20 }, (_, i) => `free-${i}.io`);
    const stage = new DnsPreFilterStage(makeManyAvailablePrimary(domains), 10, [], {
      secondaryProvider: makeDownSecondary(),
    });
    const result = await stage.process(domains.map((domain) => createMockCandidate({ domain })));
    expect(result.degradations).toEqual([
      expect.objectContaining({
        stageName: 'DnsPreFilterStage',
        reason: 'consensus-unverified',
        expectedCount: 20,
      }),
    ]);
  });

  it('does not degrade when the secondary verifies the majority', async () => {
    const domains = Array.from({ length: 20 }, (_, i) => `free-${i}.io`);
    const secondary: DnsProvider = {
      name: 'secondary-ok',
      checkAvailability: vi.fn().mockResolvedValue({
        domain: 'x.io',
        status: DomainStatus.Available,
        checkedAt: '',
      }),
      checkBulk: vi.fn(),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const stage = new DnsPreFilterStage(makeManyAvailablePrimary(domains), 10, [], {
      secondaryProvider: secondary,
    });
    const result = await stage.process(domains.map((domain) => createMockCandidate({ domain })));
    expect(result.degradations).toBeUndefined();
    expect(result.filtered).toHaveLength(0);
  });

  it('reports a disagreement (Registered) as filtered, not degraded', async () => {
    // A definitive "Registered" from the secondary is a valid consensus
    // answer — it downgrades the domain, it is NOT an unverifiable failure.
    const domains = Array.from({ length: 20 }, (_, i) => `free-${i}.io`);
    const secondary: DnsProvider = {
      name: 'secondary-registered',
      checkAvailability: vi.fn().mockResolvedValue({
        domain: 'x.io',
        status: DomainStatus.Registered,
        checkedAt: '',
      }),
      checkBulk: vi.fn(),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const stage = new DnsPreFilterStage(makeManyAvailablePrimary(domains), 10, [], {
      secondaryProvider: secondary,
    });
    const result = await stage.process(domains.map((domain) => createMockCandidate({ domain })));
    expect(result.filtered).toHaveLength(domains.length);
    expect(result.degradations).toBeUndefined();
  });

  it('does not degrade small runs below the minimum count', async () => {
    // 3 unverifiable out of 3 is 100% unverified, but with fewer than the
    // DNS_CONSENSUS_DEGRADED_MIN floor the stage stays clean — a small run
    // with one bad resolver should not flag the whole pipeline.
    const domains = ['a.io', 'b.io', 'c.io'];
    const stage = new DnsPreFilterStage(makeManyAvailablePrimary(domains), 10, [], {
      secondaryProvider: makeDownSecondary(),
    });
    const result = await stage.process(domains.map((domain) => createMockCandidate({ domain })));
    expect(result.degradations).toBeUndefined();
  });

  it('applies consensus after the per-domain fallback when checkBulk throws (ADR-0040)', async () => {
    // When the bulk check throws entirely the stage falls back to per-domain
    // checks. ADR-0002 parity requires the 2-of-3 consensus to still run on
    // that path — a down secondary must downgrade every Available verdict,
    // exactly as it does on the bulk path.
    const primary: DnsProvider = {
      name: 'primary-bulk-down',
      checkBulk: vi.fn().mockRejectedValue(new Error('bulk check failed')),
      checkAvailability: vi.fn().mockResolvedValue({
        domain: 'free.io',
        status: DomainStatus.Available,
        checkedAt: '',
      }),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const secondary: DnsProvider = {
      name: 'secondary-down',
      checkAvailability: vi.fn().mockRejectedValue(new Error('secondary unreachable')),
      checkBulk: vi.fn(),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const stage = new DnsPreFilterStage(primary, 10, [], {
      secondaryProvider: secondary,
      degradedMin: 2,
    });
    const candidates = [
      createMockCandidate({ domain: 'free.io' }),
      createMockCandidate({ domain: 'free2.io' }),
    ];
    const result = await stage.process(candidates);
    expect(result.passed).toHaveLength(0);
    for (const c of result.filtered) {
      expect(c.dnsStatus).toBe('unknown');
      expect(c.status).toBe(CandidateStatus.DnsFiltered);
    }
    expect(result.consensusStats).toEqual({
      verified: 0,
      disagreed: 0,
      unverifiable: 2,
      degraded: true,
    });
  });

  it('confirms Available verdicts on the fallback path when the secondary agrees (ADR-0040)', async () => {
    const primary: DnsProvider = {
      name: 'primary-bulk-down',
      checkBulk: vi.fn().mockRejectedValue(new Error('bulk check failed')),
      checkAvailability: vi.fn().mockResolvedValue({
        domain: 'free.io',
        status: DomainStatus.Available,
        checkedAt: '',
      }),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const secondary: DnsProvider = {
      name: 'secondary-ok',
      checkAvailability: vi.fn().mockResolvedValue({
        domain: 'x.io',
        status: DomainStatus.Available,
        checkedAt: '',
      }),
      checkBulk: vi.fn(),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const stage = new DnsPreFilterStage(primary, 10, [], {
      secondaryProvider: secondary,
      degradedMin: 2,
    });
    const candidates = [
      createMockCandidate({ domain: 'free.io' }),
      createMockCandidate({ domain: 'free2.io' }),
    ];
    const result = await stage.process(candidates);
    expect(result.passed.map((c) => c.domain).sort()).toEqual(['free.io', 'free2.io']);
    expect(result.filtered).toHaveLength(0);
    expect(result.consensusStats).toEqual({
      verified: 2,
      disagreed: 0,
      unverifiable: 0,
      degraded: false,
    });
  });

  it('honours a custom degraded ratio via config', async () => {
    const domains = ['a.io', 'b.io', 'c.io', 'd.io'];
    const secondary: DnsProvider = {
      name: 'secondary-partial',
      checkAvailability: vi.fn().mockImplementation(async (domain: string) => {
        if (domain.endsWith('a.io') || domain.endsWith('b.io')) {
          throw new Error('secondary unreachable');
        }
        return { domain, status: DomainStatus.Available, checkedAt: '' };
      }),
      checkBulk: vi.fn(),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const stage = new DnsPreFilterStage(makeManyAvailablePrimary(domains), 10, [], {
      secondaryProvider: secondary,
      degradedRatio: 0.4,
      degradedMin: 3,
    });
    const result = await stage.process(domains.map((domain) => createMockCandidate({ domain })));
    // 2/4 unverifiable = 0.5 >= 0.4, and 4 >= 3 — degraded.
    expect(result.degradations).toEqual([
      expect.objectContaining({
        reason: 'consensus-unverified',
        processedCount: 2,
        expectedCount: 4,
      }),
    ]);
  });
});
