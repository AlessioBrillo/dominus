import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrademarkGateStage } from '../trademark-gate-stage.js';
import { GateVerdict } from '../../../trademark/trademark-gate.js';
import type { TrademarkGate } from '../../../trademark/trademark-gate.js';
import type { GateResult } from '../../../trademark/trademark-gate.js';
import { CandidateSource, CandidateStatus } from '../../../types/candidate.js';
import type { DomainCandidate } from '../../../types/candidate.js';

function makeCandidate(domain: string): DomainCandidate {
  return {
    domain,
    tld: '.com',
    source: CandidateSource.KeywordCombo,
    status: CandidateStatus.Scored,
    isPremium: false,
    pipelineRunId: 'test',
  };
}

function makeMockGate(result: GateResult): TrademarkGate {
  return { check: vi.fn().mockResolvedValue(result) } as unknown as TrademarkGate;
}

describe('TrademarkGateStage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes a domain with Clear verdict', async () => {
    const gate = makeMockGate({
      domain: 'example.com',
      verdict: GateVerdict.Clear,
      verifiedSources: ['USPTO', 'EUIPO'],
    });
    const stage = new TrademarkGateStage(gate);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(0);
  });

  it('passes a domain with partial Clear verdict', async () => {
    const gate = makeMockGate({
      domain: 'example.com',
      verdict: GateVerdict.Clear,
      verifiedSources: ['USPTO'],
      partial: true,
    });
    const stage = new TrademarkGateStage(gate);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(0);
  });

  it('filters a blocked domain with TrademarkBlocked status', async () => {
    const gate = makeMockGate({
      domain: 'blocked.com',
      verdict: GateVerdict.Blocked,
      verifiedSources: ['USPTO'],
      matchedMark: 'BLOCKED',
      matchedOwner: 'Acme Inc',
      matchSource: 'USPTO',
    });
    const stage = new TrademarkGateStage(gate);
    const result = await stage.process([makeCandidate('blocked.com')]);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.status).toBe(CandidateStatus.TrademarkBlocked);
  });

  it('filters an unverified domain with Unscored status', async () => {
    const gate = makeMockGate({
      domain: 'unverified.com',
      verdict: GateVerdict.Unverified,
      verifiedSources: [],
    });
    const stage = new TrademarkGateStage(gate);
    const result = await stage.process([makeCandidate('unverified.com')]);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.status).toBe(CandidateStatus.Unscored);
  });

  it('filters an unverified domain with strict-TLD failure as Unscored', async () => {
    const gate = makeMockGate({
      domain: 'strict.com',
      verdict: GateVerdict.Unverified,
      verifiedSources: ['EUIPO'],
      usptoFailed: true,
    });
    const stage = new TrademarkGateStage(gate);
    const result = await stage.process([makeCandidate('strict.com')]);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.status).toBe(CandidateStatus.Unscored);
  });

  it('filters domain when gate.check throws', async () => {
    const gate = {
      check: vi.fn().mockRejectedValue(new Error('TM API unreachable')),
    } as unknown as TrademarkGate;
    const stage = new TrademarkGateStage(gate);
    const result = await stage.process([makeCandidate('error.com')]);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(1);
    expect(result.filtered[0]?.status).toBe(CandidateStatus.Unscored);
  });

  it('handles mixed domains with different verdicts', async () => {
    const gate = {
      check: vi
        .fn()
        .mockResolvedValueOnce({
          domain: 'good.com',
          verdict: GateVerdict.Clear,
          verifiedSources: ['USPTO'],
        } as GateResult)
        .mockResolvedValueOnce({
          domain: 'bad.com',
          verdict: GateVerdict.Blocked,
          verifiedSources: ['USPTO'],
          matchedMark: 'BAD',
          matchedOwner: 'Inc',
          matchSource: 'USPTO',
        } as GateResult)
        .mockResolvedValueOnce({
          domain: 'maybe.com',
          verdict: GateVerdict.Unverified,
          verifiedSources: [],
        } as GateResult),
    } as unknown as TrademarkGate;
    const stage = new TrademarkGateStage(gate);
    const result = await stage.process([
      makeCandidate('good.com'),
      makeCandidate('bad.com'),
      makeCandidate('maybe.com'),
    ]);
    expect(result.passed).toHaveLength(1);
    expect(result.filtered).toHaveLength(2);
  });

  it('sets stage name and duration', async () => {
    const gate = makeMockGate({
      domain: 'example.com',
      verdict: GateVerdict.Clear,
      verifiedSources: ['USPTO'],
    });
    const stage = new TrademarkGateStage(gate);
    const result = await stage.process([makeCandidate('example.com')]);
    expect(result.stageName).toBe('TrademarkGateStage');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
