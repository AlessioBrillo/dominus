import { bench, describe, vi } from 'vitest';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { CandidateGenerationStage } from '../pipeline/stages/candidate-generation-stage.js';
import { DnsPreFilterStage } from '../pipeline/stages/dns-prefilter-stage.js';
import { RdapConfirmationStage } from '../pipeline/stages/rdap-confirmation-stage.js';
import { ScoringStage } from '../pipeline/stages/scoring-stage.js';
import { TrademarkGateStage } from '../pipeline/stages/trademark-gate-stage.js';
import { DomainStatus } from '../types/domain-status.js';
import { GateVerdict } from '../trademark/trademark-gate.js';
import type { DnsProvider } from '../providers/dns/dns-provider.js';
import type { RdapProvider } from '../providers/rdap/rdap-provider.js';
import type { TrademarkGate } from '../trademark/trademark-gate.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';

function makeDnsProvider(): DnsProvider {
  return {
    name: 'BenchDns',
    checkAvailability: vi
      .fn()
      .mockResolvedValue({ domain: 'x', status: DomainStatus.Available, checkedAt: '' }),
    checkBulk: vi
      .fn()
      .mockImplementation((domains: string[]) =>
        Promise.resolve(
          domains.map((d) => ({ domain: d, status: DomainStatus.Available, checkedAt: '' })),
        ),
      ),
    clearCache: vi.fn(),
  };
}

function makeRdapProvider(): RdapProvider {
  return {
    name: 'BenchRdap',
    confirm: vi.fn().mockResolvedValue({
      domain: 'x',
      status: DomainStatus.Available,
      isPremium: false,
      checkedAt: '',
    }),
  };
}

function makeGate(): TrademarkGate {
  const gate: Partial<TrademarkGate> = {
    check: vi.fn().mockResolvedValue({
      domain: 'x',
      verdict: GateVerdict.Clear,
      verifiedSources: ['USPTO', 'EUIPO'],
      partial: false,
    }),
  };
  return gate as TrademarkGate;
}

function makeEngine(): ScoringEngine {
  const engine: Partial<ScoringEngine> = {
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
  };
  return engine as ScoringEngine;
}

describe('PipelineOrchestrator throughput benchmarks', () => {
  const engine = makeEngine();
  const gate = makeGate();
  const rdap = makeRdapProvider();
  const dns = makeDnsProvider();

  const orchestrator = new PipelineOrchestrator(
    new CandidateGenerationStage(),
    new DnsPreFilterStage(dns),
    new RdapConfirmationStage(rdap),
    new ScoringStage(engine),
    new TrademarkGateStage(gate),
  );

  bench('100 candidates', async () => {
    const names = Array.from({ length: 100 }, (_, i) => `benchmark-${i}.com`);
    await orchestrator.run({ brandableNames: names });
  });

  bench('500 candidates', async () => {
    const names = Array.from({ length: 500 }, (_, i) => `bm-${i}.com`);
    await orchestrator.run({ brandableNames: names });
  });

  bench('1000 candidates', async () => {
    const names = Array.from({ length: 1000 }, (_, i) => `b-${i}.com`);
    await orchestrator.run({ brandableNames: names });
  });
});
