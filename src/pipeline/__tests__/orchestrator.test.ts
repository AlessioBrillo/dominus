import { describe, it, expect, vi } from 'vitest';
import { PipelineOrchestrator } from '../orchestrator.js';
import { CandidateGenerationStage } from '../stages/candidate-generation-stage.js';
import { DnsPreFilterStage } from '../stages/dns-prefilter-stage.js';
import { RdapConfirmationStage } from '../stages/rdap-confirmation-stage.js';
import { ScoringStage } from '../stages/scoring-stage.js';
import { TrademarkGateStage } from '../stages/trademark-gate-stage.js';
import { DomainStatus } from '../../types/domain-status.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';
import type { DnsProvider } from '../../providers/dns/dns-provider.js';
import type { RdapProvider } from '../../providers/rdap/rdap-provider.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';

function makeMockDns(status = DomainStatus.Available): DnsProvider {
  return {
    checkAvailability: vi.fn().mockResolvedValue({ domain: 'x', status, checkedAt: '' }),
    checkBulk: vi.fn().mockImplementation((domains: string[]) =>
      Promise.resolve(domains.map((d) => ({ domain: d, status, checkedAt: '' }))),
    ),
  };
}

function makeMockRdap(available = true): RdapProvider {
  return {
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

    // Assert — DNS filtered it; scoring is never called
    expect(engine.score).not.toHaveBeenCalled();
  });

  it('Principle 3+6: scoring runs before the trademark gate', async () => {
    // Arrange — gate is blocked; we verify scoring was still called (correct order)
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

    // Assert — scoring was called (gate runs after); domain not recommended (blocked)
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

    // Assert — not recommended but scored (score should be persisted)
    expect(result.recommended).toHaveLength(0);
    expect(result.scored).toHaveLength(1);
    expect(result.scored[0]?.domain).toBe('nikestore.com');
  });

  it('Principle 6: TM Unverified verdict keeps the candidate out of recommended', async () => {
    // Arrange — gate returns Unverified (both sources down — the degrade-gracefully case
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

    // Assert — cannot confirm clearance → not recommended
    expect(result.recommended).toHaveLength(0);
    expect(result.scored[0]?.status).toBe('unscored');
  });

  it('Principle 6: unexpected gate.check() error keeps the candidate out of recommended', async () => {
    // Arrange — gate itself throws (defensive path beyond provider handling)
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

    // Assert — cannot confirm clearance → not recommended
    expect(result.recommended).toHaveLength(0);
    expect(result.scored[0]?.status).toBe('unscored');
  });

  it('result.scored includes all candidates that went through the scoring engine', async () => {
    // Arrange — one clear, one blocked
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

    // Assert — both scored (for persistence), only the clear one recommended
    expect(result.scored).toHaveLength(2);
    expect(result.recommended).toHaveLength(1);
    expect(result.recommended[0]?.domain).toBe('nova.com');
  });
});
