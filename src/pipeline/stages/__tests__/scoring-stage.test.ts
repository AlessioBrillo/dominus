import { describe, it, expect } from 'vitest';
import { ScoringStage } from '../scoring-stage.js';
import { ScoringEngine } from '../../../scoring/scoring-engine.js';
import { ManualKeywordProvider } from '../../../providers/keyword/manual-keyword-provider.js';
import { ManualCompsProvider } from '../../../providers/comps/manual-comps-provider.js';
import { CandidateSource, CandidateStatus } from '../../../types/candidate.js';
import type { DomainCandidate } from '../../../types/candidate.js';

function makeStage(): ScoringStage {
  // No data files → keyword/comps signals are zero; isolates the expiry signal.
  const engine = new ScoringEngine(new ManualKeywordProvider(), new ManualCompsProvider());
  return new ScoringStage(engine);
}

function closeoutCandidate(domain: string, closeoutMeta?: DomainCandidate['closeoutMeta']): DomainCandidate {
  return {
    domain,
    tld: '.com',
    source: CandidateSource.CloseoutCsv,
    status: CandidateStatus.Pending,
    isPremium: false,
    pipelineRunId: 'test-run',
    closeoutMeta,
  };
}

describe('ScoringStage closeout metadata threading', () => {
  it('feeds imported age/backlinks/wayback into the expiry signal', async () => {
    const stage = makeStage();

    const result = await stage.process([
      closeoutCandidate('rich.com', { domainAge: 15, backlinks: 800, waybackSnapshots: 400 }),
      closeoutCandidate('bare.com'),
    ]);

    const all = [...result.passed, ...result.filtered];
    const rich = all.find((c) => c.domain === 'rich.com');
    const bare = all.find((c) => c.domain === 'bare.com');

    // Both are closeouts, but only the one carrying metadata produces a non-zero
    // expiry signal — proving the previously-dead inputs now reach the engine.
    // After the type change to ScoreResult|null, these candidates are guaranteed
    // non-null (they came from the engine's happy path), so the non-null
    // assertions are safe in this test context.
    expect(rich!.scoreResult!.breakdown.expiry.score).toBeGreaterThan(0);
    expect(bare!.scoreResult!.breakdown.expiry.score).toBe(0);
    expect(rich!.scoreResult!.breakdown.expiry.details['domainAge']).toBe(15);
    expect(rich!.scoreResult!.breakdown.expiry.details['waybackSnapshots']).toBe(400);
    expect(rich!.scoreResult!.expectedValue).toBeGreaterThan(bare!.scoreResult!.expectedValue ?? 0);
  });
});
