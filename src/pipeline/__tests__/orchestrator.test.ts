// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import {
  PipelineOrchestrator,
  PipelineTimeoutError,
  computeStageBudgetMs,
} from '../orchestrator.js';
import { CandidateGenerationStage } from '../stages/candidate-generation-stage.js';
import { DnsPreFilterStage } from '../stages/dns-prefilter-stage.js';
import { RdapConfirmationStage } from '../stages/rdap-confirmation-stage.js';
import { ScoringStage } from '../stages/scoring-stage.js';
import { TrademarkGateStage } from '../stages/trademark-gate-stage.js';
import { DomainStatus } from '../../types/domain-status.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';
import { MockDatabaseProvider } from '../../db/provider/mock-adapter.js';
import { runWithTenant } from '../../utils/tenant-context.js';
import type { DnsProvider } from '../../providers/dns/dns-provider.js';
import type { RdapProvider } from '../../providers/rdap/rdap-provider.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';

function makeMockDns(status = DomainStatus.Available): DnsProvider {
  return {
    name: 'MockDns',
    checkAvailability: vi.fn().mockResolvedValue({ domain: 'x', status, checkedAt: '' }),
    checkBulk: vi
      .fn()
      .mockImplementation((domains: string[]) =>
        Promise.resolve(domains.map((d) => ({ domain: d, status, checkedAt: '' }))),
      ),
    clearCache: vi.fn(),
    pruneCache: vi.fn().mockReturnValue(0),
  };
}

function makeMockRdap(available = true): RdapProvider {
  return {
    name: 'mock-rdap',
    confirm: vi.fn().mockResolvedValue({
      domain: 'x',
      status: available ? DomainStatus.Available : DomainStatus.Registered,
      isPremium: false,
      checkedAt: '',
    }),
  };
}

function makeMockGate(verdict = GateVerdict.Clear): TrademarkGate {
  return {
    check: vi.fn().mockResolvedValue({
      domain: 'x',
      verdict,
      verifiedSources: verdict === GateVerdict.Clear ? ['USPTO', 'EUIPO'] : [],
      partial: false,
    }),
  } as unknown as TrademarkGate;
}

function makeMockEngine(): ScoringEngine {
  return {
    score: vi.fn().mockResolvedValue({
      domain: 'x',
      expectedValue: 100,
      confidence: 0.8,
      suggestedBuyMax: 50,
      suggestedListPrice: 300,
      breakdown: {
        intrinsic: { score: 0.7, weight: 0.3, details: {} },
        commercial: { score: 0.5, weight: 0.35, details: {} },
        market: { score: 0.4, weight: 0.25, details: {} },
        expiry: { score: 0, weight: 0.1, details: {} },
      },
      recommended: true,
      scoredAt: '',
    }),
  } as unknown as ScoringEngine;
}

describe('PipelineOrchestrator', () => {
  it('runs all 5 stages and returns recommended candidates when TM is clear', async () => {
    // Arrange
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(makeMockDns()),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(makeMockGate()),
    );

    // Act
    const result = await orchestrator.run({ brandableNames: ['nova.com', 'zenify.io'] });

    // Assert
    expect(result.recommended).toHaveLength(2);
    expect(result.stageSummary).toHaveProperty('CandidateGenerationStage');
    expect(result.stageSummary).toHaveProperty('TrademarkGateStage');
  });

  it('DNS-registered domains do not reach the scoring stage', async () => {
    // Arrange
    const dnsFiltered = makeMockDns(DomainStatus.Registered);
    const engine = makeMockEngine();
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(dnsFiltered),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(engine),
      new TrademarkGateStage(makeMockGate()),
    );

    // Act
    await orchestrator.run({ brandableNames: ['taken.com'] });

    // Assert â€” DNS filtered it; scoring is never called
    expect(engine.score).not.toHaveBeenCalled();
  });

  it('Principle 3+6: scoring runs before the trademark gate', async () => {
    // Arrange â€” gate is blocked; we verify scoring was still called (correct order)
    const gate = makeMockGate(GateVerdict.Blocked);
    const engine = makeMockEngine();
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(makeMockDns()),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(engine),
      new TrademarkGateStage(gate),
    );

    // Act
    const result = await orchestrator.run({ brandableNames: ['nikestore.com'] });

    // Assert â€” scoring was called (gate runs after); domain not recommended (blocked)
    expect(engine.score).toHaveBeenCalled();
    expect(result.recommended).toHaveLength(0);
  });

  it('TM-blocked candidates are not in recommended but appear in scored', async () => {
    // Arrange
    const gate = makeMockGate(GateVerdict.Blocked);
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(makeMockDns()),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(gate),
    );

    // Act
    const result = await orchestrator.run({ brandableNames: ['nikestore.com'] });

    // Assert â€” not recommended but scored (score should be persisted)
    expect(result.recommended).toHaveLength(0);
    expect(result.scored).toHaveLength(1);
    expect(result.scored[0]?.domain).toBe('nikestore.com');
  });

  it('Principle 6: TM Unverified verdict keeps the candidate out of recommended', async () => {
    // Arrange â€” gate returns Unverified (both sources down â€” the degrade-gracefully case
    // where no source responded)
    const gate = makeMockGate(GateVerdict.Unverified);
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(makeMockDns()),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(gate),
    );

    // Act
    const result = await orchestrator.run({ brandableNames: ['unknowntm.com'] });

    // Assert â€” cannot confirm clearance â†’ not recommended
    expect(result.recommended).toHaveLength(0);
    expect(result.scored[0]?.status).toBe('unscored');
  });

  it('Principle 6: unexpected gate.check() error keeps the candidate out of recommended', async () => {
    // Arrange â€” gate itself throws (defensive path beyond provider handling)
    const brokenGate: TrademarkGate = {
      check: vi.fn().mockRejectedValue(new Error('TM API unavailable')),
    } as unknown as TrademarkGate;
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(makeMockDns()),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(brokenGate),
    );

    // Act
    const result = await orchestrator.run({ brandableNames: ['unknowntm.com'] });

    // Assert â€” cannot confirm clearance â†’ not recommended
    expect(result.recommended).toHaveLength(0);
    expect(result.scored[0]?.status).toBe('unscored');
  });

  it('result.scored includes all candidates that went through the scoring engine', async () => {
    // Arrange â€” one clear, one blocked
    const gate = { check: vi.fn() } as unknown as TrademarkGate;
    (gate.check as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        domain: 'nova.com',
        verdict: GateVerdict.Clear,
        verifiedSources: ['USPTO', 'EUIPO'],
        partial: false,
      })
      .mockResolvedValueOnce({
        domain: 'nikestore.com',
        verdict: GateVerdict.Blocked,
        verifiedSources: ['EUIPO'],
      });

    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(makeMockDns()),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(gate),
    );

    // Act
    const result = await orchestrator.run({ brandableNames: ['nova.com', 'nikestore.com'] });

    // Assert â€” both scored (for persistence), only the clear one recommended
    expect(result.scored).toHaveLength(2);
    expect(result.recommended).toHaveLength(1);
    expect(result.recommended[0]?.domain).toBe('nova.com');
  });

  it('rejects immediately when externalSignal is already aborted', async () => {
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(makeMockDns()),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(makeMockGate()),
    );

    const signal = AbortSignal.abort('Shutdown requested');
    const start = Date.now();
    await expect(
      orchestrator.run({ brandableNames: ['nova.com'] }, undefined, signal),
    ).rejects.toThrow();
    // Must reject in under 50ms — no real work was done
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('rejects concurrent runs for the same tenant', async () => {
    // Slow stage (1s delay) + short timeout (50ms) ensures the first run
    // sets #activeTenants synchronously, then quickly times out. The
    // second call is dispatched before the first run's timeout fires.
    const slowStage: CandidateGenerationStage = {
      name: 'slow-gen',
      process: vi.fn().mockImplementation(() => new Promise((r) => setTimeout(r, 1_000))),
    } as unknown as CandidateGenerationStage;
    const orchestrator = new PipelineOrchestrator(
      slowStage,
      new DnsPreFilterStage(makeMockDns()),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(makeMockGate()),
      50,
    );

    void orchestrator.run({ brandableNames: ['nova.com'] });
    await expect(orchestrator.run({ brandableNames: ['second.com'] })).rejects.toThrow(
      'concurrent per-tenant runs are not supported',
    );
  });

  it('allows concurrent runs for different tenants', async () => {
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(makeMockDns()),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(makeMockGate()),
    );

    const runA = runWithTenant('tenant-a', () =>
      orchestrator.run({ brandableNames: ['nova.com'] }),
    );
    const runB = runWithTenant('tenant-b', () =>
      orchestrator.run({ brandableNames: ['zenify.io'] }),
    );

    const results = await Promise.allSettled([runA, runB]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('fulfilled');
  });

  it('times out when a stage exceeds the configured timeout', async () => {
    // CandidateGeneration must finish quickly; a later stage triggers the timeout
    // so the PipelineTimeoutError propagates past the CandidateGeneration catch block
    const slowDns: DnsProvider = {
      name: 'SlowDns',
      checkAvailability: vi.fn().mockImplementation(() => new Promise((r) => setTimeout(r, 50))),
      checkBulk: vi.fn(),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(slowDns),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(makeMockGate()),
      10,
    );

    await expect(orchestrator.run({ brandableNames: ['nova.com'] })).rejects.toThrow(
      PipelineTimeoutError,
    );
  });

  it('skips raceWithTimeout when timeoutMs is 0 (no deadline)', async () => {
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(makeMockDns()),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(makeMockGate()),
      0,
    );

    // When timeoutMs = 0, the pipeline runs without a deadline
    const result = await orchestrator.run({ brandableNames: ['nova.com'] });
    expect(result.recommended).toHaveLength(1);
    expect(result.stageSummary).toHaveProperty('CandidateGenerationStage');
  });

  it('invokes the onStageProgress callback for each non-fatal stage', async () => {
    const progress = vi.fn();
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(makeMockDns()),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(makeMockGate()),
    );
    orchestrator.setOnStageProgress(progress);

    await orchestrator.run({ brandableNames: ['nova.com'] });

    expect(progress).toHaveBeenCalledTimes(5);
    expect(progress).toHaveBeenNthCalledWith(
      1,
      'CandidateGenerationStage',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      false,
    );
    expect(progress).toHaveBeenNthCalledWith(
      2,
      'DnsPreFilterStage',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      false,
    );
    expect(progress).toHaveBeenNthCalledWith(
      5,
      'TrademarkGateStage',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      false,
    );
  });

  it('acquires and releases advisory lock when db is provided', async () => {
    const db = new MockDatabaseProvider();
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(makeMockDns()),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(makeMockGate()),
      3_600_000,
      undefined,
      db,
    );

    const result = await orchestrator.run({ brandableNames: ['nova.com'] });

    expect(result.recommended).toHaveLength(1);
    const lockCalls = db.calls.filter((c) => ['tryLock', 'renewLock', 'unlock'].includes(c.method));
    expect(lockCalls.length).toBeGreaterThanOrEqual(2);
    expect(lockCalls[0]!.method).toBe('tryLock');
    expect(lockCalls[lockCalls.length - 1]!.method).toBe('unlock');
  });
});

describe('computeStageBudgetMs', () => {
  it('returns the configured base for an empty stage input', () => {
    expect(computeStageBudgetMs(0, { baseMs: 5_000 })).toBe(5_000);
  });

  it('scales linearly with the number of candidates', () => {
    expect(computeStageBudgetMs(10_000, { baseMs: 5_000, perCandidateMs: 200 })).toBe(2_005_000);
  });

  it('caps the budget at the configured maximum', () => {
    expect(computeStageBudgetMs(100_000, { perCandidateMs: 200, capMs: 60_000 })).toBe(60_000);
  });
});

describe('PipelineOrchestrator (stage budget integrity)', () => {
  it('records a timeout degradation when a stage exceeds its budget with no partial results', async () => {
    // Arrange — a DNS provider whose bulk check never settles: under the old
    // fixed 5-minute budget the whole run would silently finish empty
    const hangingDns: DnsProvider = {
      name: 'HangingDns',
      checkAvailability: vi.fn().mockImplementation(() => new Promise(() => {})),
      checkBulk: vi.fn().mockImplementation(() => new Promise(() => {})),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(hangingDns),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(makeMockGate()),
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      { baseMs: 40, perCandidateMs: 0, capMs: 200, graceMs: 20 },
    );

    // Act
    const result = await orchestrator.run({ brandableNames: ['nova.com'] });

    // Assert — the run completes, is marked degraded, and names the guilty stage
    expect(result.degraded).toBe(true);
    expect(result.degradedReasons).toHaveLength(1);
    expect(result.degradedReasons[0]!.stageName).toBe('DnsPreFilter');
    expect(result.degradedReasons[0]!.reason).toBe('timeout');
    expect(result.degradedReasons[0]!.processedCount).toBe(0);
    expect(result.degradedReasons[0]!.expectedCount).toBe(1);
    expect(result.recommended).toHaveLength(0);
  });

  it('harvests partial results when a stage aborts after processing part of the input', async () => {
    // Arrange — DNS resolves on abort (abort-aware stage): the timeout must
    // not throw away the already-computed results
    const abortResolvingDns: DnsProvider = {
      name: 'AbortResolvingDns',
      checkAvailability: vi.fn().mockImplementation(() => new Promise(() => {})),
      checkBulk: vi
        .fn()
        .mockImplementation(
          (domains: string[], signal?: AbortSignal) =>
            new Promise((resolve) => {
              const results = domains.map((d) => ({
                domain: d,
                status: DomainStatus.Available,
                checkedAt: '',
              }));
              const onAbort = (): void => resolve(results);
              signal?.addEventListener('abort', onAbort, { once: true });
            }),
        ),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(abortResolvingDns),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(makeMockGate()),
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      { baseMs: 30, perCandidateMs: 0, capMs: 500, graceMs: 500 },
    );

    // Act
    const result = await orchestrator.run({ brandableNames: ['nova.com', 'zenify.io'] });

    // Assert — the partial results survive and the run is still flagged
    expect(result.degraded).toBe(true);
    expect(result.degradedReasons).toHaveLength(1);
    expect(result.degradedReasons[0]!.stageName).toBe('DnsPreFilter');
    expect(result.degradedReasons[0]!.reason).toBe('timeout');
    expect(result.degradedReasons[0]!.processedCount).toBe(2);
    expect(result.degradedReasons[0]!.expectedCount).toBe(2);
    expect(result.recommended).toHaveLength(2);
  });

  it('scales the stage budget with candidate count so slow finite stages complete', async () => {
    // Arrange — a DNS provider that takes 40ms per bulk check: with a fixed
    // small budget the run would time out; the scaled budget must let it finish
    const slowDns: DnsProvider = {
      name: 'SlowDns',
      checkAvailability: vi.fn().mockImplementation(() => new Promise(() => {})),
      checkBulk: vi.fn().mockImplementation(async (domains: string[]) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return domains.map((d) => ({ domain: d, status: DomainStatus.Available, checkedAt: '' }));
      }),
      clearCache: vi.fn(),
      pruneCache: vi.fn().mockReturnValue(0),
    };
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(slowDns),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(makeMockGate()),
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      { baseMs: 30, perCandidateMs: 50, capMs: 1_000, graceMs: 50 },
    );

    // Act
    const result = await orchestrator.run({
      brandableNames: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'],
    });

    // Assert — 5 candidates × 40ms = 200ms < 280ms budget → no degradation
    expect(result.degraded).toBe(false);
    expect(result.degradedReasons).toHaveLength(0);
    expect(result.recommended).toHaveLength(5);
  });
});
