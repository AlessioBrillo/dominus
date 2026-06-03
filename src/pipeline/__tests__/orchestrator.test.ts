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
  return { check: vi.fn().mockResolvedValue({ domain: 'x', verdict }) } as unknown as TrademarkGate;
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
  it('runs all 5 stages in order and returns recommended candidates', async () => {
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(makeMockDns()),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(makeMockEngine()),
      new TrademarkGateStage(makeMockGate()),
    );

    const result = await orchestrator.run({ brandableNames: ['nova.com', 'zenify.io'] });
    expect(result.recommended).toHaveLength(2);
    expect(result.stageSummary).toHaveProperty('CandidateGenerationStage');
    expect(result.stageSummary).toHaveProperty('TrademarkGateStage');
  });

  it('DNS-registered domains do not reach scoring stage', async () => {
    const dnsFiltered = makeMockDns(DomainStatus.Registered);
    const engine = makeMockEngine();
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(dnsFiltered),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(engine),
      new TrademarkGateStage(makeMockGate()),
    );

    await orchestrator.run({ brandableNames: ['taken.com'] });
    expect(engine.score).not.toHaveBeenCalled();
  });

  it('trademark-blocked domains do not reach scoring', async () => {
    const gate = makeMockGate(GateVerdict.Blocked);
    const engine = makeMockEngine();
    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      new DnsPreFilterStage(makeMockDns()),
      new RdapConfirmationStage(makeMockRdap()),
      new ScoringStage(engine),
      new TrademarkGateStage(gate),
    );

    await orchestrator.run({ brandableNames: ['nikestore.com'] });
    expect(engine.score).not.toHaveBeenCalled();
  });
});
