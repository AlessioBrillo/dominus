// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { PipelineOrchestrator } from '../orchestrator.js';
import { CandidateGenerationStage } from '../stages/candidate-generation-stage.js';
import type { DnsPreFilterStage } from '../stages/dns-prefilter-stage.js';
import type { RdapConfirmationStage } from '../stages/rdap-confirmation-stage.js';
import type { ScoringStage } from '../stages/scoring-stage.js';
import { TrademarkGateStage } from '../stages/trademark-gate-stage.js';
import { DomainStatus } from '../../types/domain-status.js';
import { CandidateStatus, CandidateSource } from '../../types/candidate.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';

function makeMockGate(verdict = GateVerdict.Clear): unknown {
  return {
    check: vi.fn().mockResolvedValue({
      domain: 'x',
      verdict,
      verifiedSources: verdict === GateVerdict.Clear ? ['USPTO', 'EUIPO'] : [],
      partial: false,
    }),
  };
}

describe('Pipeline Orchestrator Unknown short-circuit', () => {
  it('short-circuits domains marked Unknown before reaching scoring', async () => {
    // Arrange: Mock RDAP to return Unknown but mistakenly put it in 'passed'
    const rdap = {
      name: 'RdapConfirmationStage',
      process: vi.fn().mockResolvedValue({
        passed: [
          {
            domain: 'unknown.com',
            tld: '.com',
            source: CandidateSource.KeywordCombo,
            status: CandidateStatus.Pending,
            isPremium: false,
            pipelineRunId: 'test',
            rdapStatus: DomainStatus.Unknown, // Should have been filtered
          },
        ],
        filtered: [],
        stageName: 'RdapConfirmationStage',
        durationMs: 0,
      }),
    } as unknown as RdapConfirmationStage;

    const scoring = {
      name: 'ScoringStage',
      process: vi
        .fn()
        .mockResolvedValue({ passed: [], filtered: [], stageName: 'ScoringStage', durationMs: 0 }),
    } as unknown as ScoringStage;

    const dns = {
      name: 'DnsPreFilterStage',
      process: vi.fn().mockResolvedValue({
        passed: [
          {
            domain: 'unknown.com',
            tld: '.com',
            source: CandidateSource.KeywordCombo,
            status: CandidateStatus.Pending,
            isPremium: false,
            pipelineRunId: 'test',
          },
        ],
        filtered: [],
        stageName: 'DnsPreFilterStage',
        durationMs: 0,
      }),
    } as unknown as DnsPreFilterStage;

    const orchestrator = new PipelineOrchestrator(
      new CandidateGenerationStage(),
      dns,
      rdap,
      scoring,
      new TrademarkGateStage(makeMockGate() as TrademarkGate),
    );

    // Act
    await orchestrator.run({ brandableNames: ['unknown.com'] });

    // Assert: Scoring stage should not have been called with unknown.com
    expect(scoring.process).toHaveBeenCalledWith(
      expect.not.arrayContaining([expect.objectContaining({ domain: 'unknown.com' })]),
      expect.anything(),
    );
  });
});
